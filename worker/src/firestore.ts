import { getServiceAccountAccessToken, parseServiceAccount } from "./google-service-account";

/** Minimal Firestore REST client — the Worker can't run the Node firebase-admin SDK. */

type FsValue =
  | { stringValue: string }
  | { doubleValue: number }
  | { integerValue: string }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } };

function toFsValue(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === "object") {
    return { mapValue: { fields: toFsFields(v as Record<string, unknown>) } };
  }
  return { stringValue: String(v) };
}

function fromFsValue(v: FsValue): unknown {
  if ("stringValue" in v) return v.stringValue;
  if ("doubleValue" in v) return v.doubleValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromFsValue);
  if ("mapValue" in v) return fromFsFields(v.mapValue.fields ?? {});
  return null;
}

function toFsFields(obj: Record<string, unknown>): Record<string, FsValue> {
  const out: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = toFsValue(v);
  return out;
}

function fromFsFields(fields: Record<string, FsValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = fromFsValue(v);
  return out;
}

export class FirestoreClient {
  private projectId: string;
  private serviceAccountRaw: string;
  private baseUrl: string;

  constructor(serviceAccountRaw: string, projectId: string) {
    this.serviceAccountRaw = serviceAccountRaw;
    this.projectId = projectId;
    this.baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  }

  private async authHeader(): Promise<Record<string, string>> {
    const token = await getServiceAccountAccessToken(this.serviceAccountRaw);
    return { Authorization: `Bearer ${token}` };
  }

  /** users/{uid}/{collection}[/{docId}] */
  userPath(uid: string, collection: string, docId?: string) {
    return docId ? `users/${uid}/${collection}/${docId}` : `users/${uid}/${collection}`;
  }

  async getDoc(path: string): Promise<{ id: string; data: Record<string, unknown> } | null> {
    const res = await fetch(`${this.baseUrl}/${path}`, { headers: await this.authHeader() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore getDoc failed (${res.status})`);
    const json = (await res.json()) as { name: string; fields?: Record<string, FsValue> };
    const id = json.name.split("/").pop()!;
    return { id, data: fromFsFields(json.fields ?? {}) };
  }

  async listDocs(
    path: string,
    opts: { orderBy?: string; limit?: number } = {},
  ): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
    const out: Array<{ id: string; data: Record<string, unknown> }> = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${this.baseUrl}/${path}`);
      url.searchParams.set("pageSize", String(opts.limit ?? 300));
      if (opts.orderBy) url.searchParams.set("orderBy", opts.orderBy);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await fetch(url, { headers: await this.authHeader() });
      if (!res.ok) throw new Error(`Firestore listDocs failed (${res.status})`);
      const json = (await res.json()) as {
        documents?: Array<{ name: string; fields?: Record<string, FsValue> }>;
        nextPageToken?: string;
      };
      for (const doc of json.documents ?? []) {
        out.push({ id: doc.name.split("/").pop()!, data: fromFsFields(doc.fields ?? {}) });
      }
      pageToken = json.nextPageToken;
      if (opts.limit && out.length >= opts.limit) break;
    } while (pageToken);
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  /**
   * Queries a subcollection by name across every user at once (e.g. every
   * user's `email_connections`) — used by the scheduled sync cron, which
   * has no single uid to scope a normal path-based read to.
   */
  async listCollectionGroup(
    collectionId: string,
  ): Promise<Array<{ uid: string; id: string; data: Record<string, unknown> }>> {
    const res = await fetch(`${this.baseUrl}:runQuery`, {
      method: "POST",
      headers: { ...(await this.authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify({
        structuredQuery: { from: [{ collectionId, allDescendants: true }] },
      }),
    });
    if (!res.ok) throw new Error(`Firestore collection-group query failed (${res.status})`);
    const rows = (await res.json()) as Array<{
      document?: { name: string; fields?: Record<string, FsValue> };
    }>;
    const out: Array<{ uid: string; id: string; data: Record<string, unknown> }> = [];
    for (const row of rows) {
      if (!row.document) continue;
      const marker = "/documents/";
      const relative = row.document.name.slice(row.document.name.indexOf(marker) + marker.length);
      const parts = relative.split("/"); // ["users", "{uid}", collectionId, "{id}"]
      const uid = parts[1];
      const id = parts[parts.length - 1];
      if (!uid || !id) continue;
      out.push({ uid, id, data: fromFsFields(row.document.fields ?? {}) });
    }
    return out;
  }

  /** Creates or merges fields into a document (like client-SDK setDoc(..., {merge:true})). */
  async setDoc(path: string, data: Record<string, unknown>, merge = true): Promise<void> {
    const url = new URL(`${this.baseUrl}/${path}`);
    if (merge) {
      for (const key of Object.keys(data)) url.searchParams.append("updateMask.fieldPaths", key);
    }
    const res = await fetch(url, {
      method: "PATCH",
      headers: { ...(await this.authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify({ fields: toFsFields(data) }),
    });
    if (!res.ok) throw new Error(`Firestore setDoc failed (${res.status})`);
  }

  async deleteDoc(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/${path}`, {
      method: "DELETE",
      headers: await this.authHeader(),
    });
    if (!res.ok && res.status !== 404)
      throw new Error(`Firestore deleteDoc failed (${res.status})`);
  }

  /**
   * Atomically bumps an account's current_balance and writes a new document
   * in one Firestore transaction — mirrors the client SDK's insertTransaction
   * so imported transactions keep account balances correct.
   */
  async createTransactionWithBalanceUpdate(
    uid: string,
    accountId: string | null,
    balanceDelta: number,
    transactionDocId: string,
    transactionFields: Record<string, unknown>,
  ): Promise<void> {
    const beginRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents:beginTransaction`,
      {
        method: "POST",
        headers: { ...(await this.authHeader()), "Content-Type": "application/json" },
        body: JSON.stringify({ options: { readWrite: {} } }),
      },
    );
    if (!beginRes.ok) throw new Error("Could not start Firestore transaction");
    const { transaction } = (await beginRes.json()) as { transaction: string };

    const writes: Record<string, unknown>[] = [];
    const docRoot = `projects/${this.projectId}/databases/(default)/documents`;

    if (accountId) {
      const account = await this.getDoc(this.userPath(uid, "accounts", accountId));
      const currentBalance = Number(account?.data.current_balance ?? 0);
      writes.push({
        update: {
          name: `${docRoot}/${this.userPath(uid, "accounts", accountId)}`,
          fields: { current_balance: toFsValue(currentBalance + balanceDelta) },
        },
        updateMask: { fieldPaths: ["current_balance"] },
      });
    }

    writes.push({
      update: {
        name: `${docRoot}/${this.userPath(uid, "transactions", transactionDocId)}`,
        fields: toFsFields(transactionFields),
      },
    });

    const commitRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents:commit`,
      {
        method: "POST",
        headers: { ...(await this.authHeader()), "Content-Type": "application/json" },
        body: JSON.stringify({ writes, transaction }),
      },
    );
    if (!commitRes.ok) {
      console.error("[worker] transaction commit failed", commitRes.status);
      throw new Error("Could not save the transaction");
    }
  }

  /**
   * The inverse of createTransactionWithBalanceUpdate — reverses an
   * account's balance by the same delta that was applied when the given
   * transaction was created, and deletes it. Used when a reprocessed email
   * supersedes a transaction it previously created.
   */
  async deleteTransactionWithBalanceUpdate(
    uid: string,
    accountId: string | null,
    balanceDelta: number,
    transactionDocId: string,
  ): Promise<void> {
    const beginRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents:beginTransaction`,
      {
        method: "POST",
        headers: { ...(await this.authHeader()), "Content-Type": "application/json" },
        body: JSON.stringify({ options: { readWrite: {} } }),
      },
    );
    if (!beginRes.ok) throw new Error("Could not start Firestore transaction");
    const { transaction } = (await beginRes.json()) as { transaction: string };

    const writes: Record<string, unknown>[] = [];
    const docRoot = `projects/${this.projectId}/databases/(default)/documents`;

    if (accountId) {
      const account = await this.getDoc(this.userPath(uid, "accounts", accountId));
      const currentBalance = Number(account?.data.current_balance ?? 0);
      writes.push({
        update: {
          name: `${docRoot}/${this.userPath(uid, "accounts", accountId)}`,
          fields: { current_balance: toFsValue(currentBalance - balanceDelta) },
        },
        updateMask: { fieldPaths: ["current_balance"] },
      });
    }

    writes.push({ delete: `${docRoot}/${this.userPath(uid, "transactions", transactionDocId)}` });

    const commitRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents:commit`,
      {
        method: "POST",
        headers: { ...(await this.authHeader()), "Content-Type": "application/json" },
        body: JSON.stringify({ writes, transaction }),
      },
    );
    if (!commitRes.ok) {
      console.error("[worker] transaction delete-commit failed", commitRes.status);
      throw new Error("Could not remove the previous transaction");
    }
  }
}

export function firestoreClientFromEnv(env: {
  FIREBASE_SERVICE_ACCOUNT: string;
  FIREBASE_PROJECT_ID: string;
}): FirestoreClient {
  const sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
  return new FirestoreClient(
    env.FIREBASE_SERVICE_ACCOUNT,
    env.FIREBASE_PROJECT_ID || sa.project_id,
  );
}
