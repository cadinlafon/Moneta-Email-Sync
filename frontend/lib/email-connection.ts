import { useQuery } from "@tanstack/react-query";
import { auth } from "@/services/firebase";

/**
 * Client for the separate Cloudflare Worker that powers "Connect Email"
 * (see worker/README.md). The Worker — not this app — holds every real
 * secret (the Firebase service account, the token encryption key); the
 * browser only ever sees this base URL, its own Firebase ID token (attached
 * the same way TanStack Start server functions do it), and — just for the
 * connect call — the Gmail app password the user types in, which the
 * Worker verifies and encrypts before it's ever stored.
 */

export function emailWorkerConfigured(): boolean {
  return Boolean(import.meta.env["VITE_EMAIL_WORKER_URL"]);
}

function workerUrl(path: string): string {
  const base = import.meta.env["VITE_EMAIL_WORKER_URL"] as string | undefined;
  if (!base) throw new Error("Email connection is not configured for this deployment.");
  return `${base.replace(/\/$/, "")}${path}`;
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("You need to be signed in.");
  return fetch(workerUrl(path), {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

async function parseOrThrow<T>(res: Response, fallbackMessage: string): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // no JSON body
  }
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : fallbackMessage;
    throw new Error(message);
  }
  return body as T;
}

export type SyncFrequency =
  "manual" | "5min" | "10min" | "15min" | "30min" | "hourly" | "2h" | "daily" | "custom";

export type EmailStatus =
  | { status: "not_connected" }
  | {
      status: "connected" | "error" | "syncing";
      email: string;
      provider: string;
      lastSyncedAt: string | null;
      lastSyncError: string | null;
      emailsScannedTotal: number;
      transactionsFoundTotal: number;
      transactionsImportedTotal: number;
      syncFrequency: SyncFrequency;
      customIntervalMinutes: number | null;
      searchFolder: string;
      searchSenders: string[];
      searchKeywords: string[];
    };

export async function fetchEmailStatus(): Promise<EmailStatus> {
  const res = await authedFetch("/email/status");
  return parseOrThrow<EmailStatus>(res, "Could not load your email connection status.");
}

export function useEmailStatus() {
  return useQuery({
    queryKey: ["email-connection-status"],
    queryFn: fetchEmailStatus,
    enabled: emailWorkerConfigured(),
    retry: false,
  });
}

/**
 * Temporary connect path: Gmail via IMAP + a Google App Password, verified
 * and stored server-side. Stands in for real OAuth (see worker/README.md).
 */
export async function connectEmailWithAppPassword(
  email: string,
  appPassword: string,
): Promise<void> {
  const res = await authedFetch("/email/connect", {
    method: "POST",
    body: JSON.stringify({ email, appPassword }),
  });
  await parseOrThrow(res, "We couldn't connect your email. Please try again.");
}

export async function disconnectEmail(): Promise<void> {
  const res = await authedFetch("/email/disconnect", { method: "POST" });
  await parseOrThrow(res, "We couldn't disconnect your email. Please try again.");
}

export type SyncSummary = {
  emailsScanned: number;
  transactionsFound: number;
  imported: number;
  needsReview: number;
};

export async function syncEmailNow(): Promise<SyncSummary> {
  const res = await authedFetch("/email/sync", { method: "POST" });
  return parseOrThrow<SyncSummary>(res, "We couldn't finish syncing your email. Please try again.");
}

/**
 * How often the Worker's cron trigger should sync this connection on its own,
 * without you clicking Sync Now. `customMinutes` is required when frequency
 * is "custom" (5–10080 minutes), ignored otherwise.
 */
export async function setEmailSyncFrequency(
  frequency: SyncFrequency,
  customMinutes?: number,
): Promise<void> {
  const res = await authedFetch("/email/schedule", {
    method: "POST",
    body: JSON.stringify({ frequency, ...(customMinutes !== undefined ? { customMinutes } : {}) }),
  });
  await parseOrThrow(res, "Could not update the sync schedule.");
}

export type SearchSettings = {
  folder: string;
  senders: string[];
  keywords: string[];
};

/**
 * What a sync searches for: which IMAP folder/label, which sender keywords,
 * which subject keywords. Changing this also resets the "last synced" point
 * so the next sync re-checks the folder from the start under the new
 * criteria — already-processed emails are still skipped via dedupe.
 */
export async function setEmailSearchSettings(settings: SearchSettings): Promise<void> {
  const res = await authedFetch("/email/search-settings", {
    method: "POST",
    body: JSON.stringify(settings),
  });
  await parseOrThrow(res, "Could not save those search settings.");
}

export type ScannedEmail = {
  id: string;
  from: string;
  subject: string;
  outcome: "imported" | "review" | "ignored";
  processedAt: string;
};

/** The most recent emails a sync has actually looked at, regardless of what came of each one. */
export async function fetchScannedEmails(): Promise<ScannedEmail[]> {
  const res = await authedFetch("/email/scanned");
  const data = await parseOrThrow<{ items: ScannedEmail[] }>(res, "Could not load scanned emails.");
  return data.items;
}

export type ReprocessResult = {
  outcome: "imported" | "review" | "ignored";
  reason: string;
};

/**
 * Re-runs classification on one already-scanned email — the recovery path
 * when the AI misjudged it the first time (e.g. marked "not a transaction"
 * when it clearly was one). Relocates the message in the mailbox and
 * overwrites its recorded outcome.
 */
export async function reprocessScannedEmail(messageId: string): Promise<ReprocessResult> {
  const res = await authedFetch("/email/reprocess", {
    method: "POST",
    body: JSON.stringify({ messageId }),
  });
  return parseOrThrow<ReprocessResult>(res, "Could not reprocess this email.");
}

export function useScannedEmails(enabled: boolean) {
  return useQuery({
    queryKey: ["email-scanned"],
    queryFn: fetchScannedEmails,
    enabled: emailWorkerConfigured() && enabled,
  });
}

export type ReviewItem = {
  id: string;
  message_id: string;
  type: "income" | "expense" | "reimbursement" | "refund" | "transfer";
  amount: number;
  currency: string;
  occurred_on: string;
  merchant: string | null;
  description: string | null;
  institution: string | null;
  category_id: string | null;
  account_id: string | null;
  email_subject: string;
  email_from: string;
  confidence: number;
  status: "pending" | "approved" | "rejected";
  created_at: string;
};

export async function fetchReviewItems(): Promise<ReviewItem[]> {
  const res = await authedFetch("/email/review");
  const data = await parseOrThrow<{ items: ReviewItem[] }>(
    res,
    "Could not load transactions awaiting review.",
  );
  return data.items;
}

export function useReviewItems() {
  return useQuery({
    queryKey: ["email-review-items"],
    queryFn: fetchReviewItems,
    enabled: emailWorkerConfigured(),
  });
}

export async function approveReviewItem(
  id: string,
  overrides?: Partial<{
    amount: number;
    type: ReviewItem["type"];
    occurred_on: string;
    merchant: string;
    description: string;
    category_id: string | null;
    account_id: string | null;
  }>,
): Promise<void> {
  const res = await authedFetch(`/email/review/${id}/approve`, {
    method: "POST",
    body: JSON.stringify(overrides ?? {}),
  });
  await parseOrThrow(res, "Could not approve this transaction.");
}

export async function rejectReviewItem(id: string): Promise<void> {
  const res = await authedFetch(`/email/review/${id}/reject`, { method: "POST" });
  await parseOrThrow(res, "Could not reject this transaction.");
}
