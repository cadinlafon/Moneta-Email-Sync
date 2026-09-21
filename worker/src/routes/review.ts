import type { Context } from "hono";
import type { AppContext } from "../middleware";
import { firestoreClientFromEnv } from "../firestore";
import type { ReviewTransaction, TransactionType } from "../types";

const VALID_TYPES = new Set<TransactionType>([
  "income",
  "expense",
  "reimbursement",
  "refund",
  "transfer",
]);

/** GET /email/review — pending transactions awaiting the user's decision. */
export async function listReviewHandler(c: Context<AppContext>) {
  const uid = c.get("uid");
  const fs = firestoreClientFromEnv(c.env);
  const docs = await fs.listDocs(fs.userPath(uid, "review_transactions"));
  const pending = docs
    .map((d) => ({ id: d.id, ...(d.data as Omit<ReviewTransaction, "id">) }))
    .filter((r) => r.status === "pending")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return c.json({ items: pending });
}

type ApproveBody = Partial<{
  amount: number;
  type: TransactionType;
  occurred_on: string;
  merchant: string;
  description: string;
  category_id: string | null;
  account_id: string | null;
}>;

/** POST /email/review/:id/approve — optionally accepts edited fields, then creates the real transaction. */
export async function approveReviewHandler(c: Context<AppContext>) {
  const uid = c.get("uid");
  const id = c.req.param("id");
  const fs = firestoreClientFromEnv(c.env);

  const doc = await fs.getDoc(fs.userPath(uid, "review_transactions", id));
  if (!doc) return c.json({ error: "Review item not found" }, 404);
  const review = doc.data as Omit<ReviewTransaction, "id">;
  if (review.status !== "pending") {
    return c.json({ error: "This item has already been decided" }, 409);
  }

  let overrides: ApproveBody = {};
  try {
    overrides = ((await c.req.json().catch(() => ({}))) ?? {}) as ApproveBody;
  } catch {
    overrides = {};
  }

  const type = overrides.type && VALID_TYPES.has(overrides.type) ? overrides.type : review.type;
  const amount =
    typeof overrides.amount === "number" && overrides.amount > 0 ? overrides.amount : review.amount;
  const occurredOn = overrides.occurred_on ?? review.occurred_on;
  const accountId = overrides.account_id !== undefined ? overrides.account_id : review.account_id;
  const categoryId =
    overrides.category_id !== undefined ? overrides.category_id : review.category_id;

  const transactionRef = crypto.randomUUID();
  const delta = type === "expense" ? -amount : type === "transfer" ? 0 : amount;

  await fs.createTransactionWithBalanceUpdate(uid, accountId, delta, transactionRef, {
    account_id: accountId,
    to_account_id: null,
    category_id: categoryId,
    type,
    amount,
    occurred_on: occurredOn,
    description: overrides.description ?? review.description ?? review.merchant,
    merchant: overrides.merchant ?? review.merchant,
    notes: `Imported from email — ${review.email_subject}`,
    receipt_url: null,
    created_at: new Date().toISOString(),
    email_message_id: review.message_id,
  });

  await fs.setDoc(
    fs.userPath(uid, "review_transactions", id),
    { status: "approved", resolved_at: new Date().toISOString() },
    true,
  );

  const connectionDoc = await fs.getDoc(fs.userPath(uid, "email_connections", "gmail"));
  if (connectionDoc) {
    const imported = Number(connectionDoc.data.transactions_imported_total ?? 0);
    await fs.setDoc(
      fs.userPath(uid, "email_connections", "gmail"),
      { transactions_imported_total: imported + 1 },
      true,
    );
  }

  return c.json({ ok: true, transactionId: transactionRef });
}

/** POST /email/review/:id/reject — discards the suggestion; nothing is added to the ledger. */
export async function rejectReviewHandler(c: Context<AppContext>) {
  const uid = c.get("uid");
  const id = c.req.param("id");
  const fs = firestoreClientFromEnv(c.env);

  const doc = await fs.getDoc(fs.userPath(uid, "review_transactions", id));
  if (!doc) return c.json({ error: "Review item not found" }, 404);
  if ((doc.data as { status: string }).status !== "pending") {
    return c.json({ error: "This item has already been decided" }, 409);
  }

  await fs.setDoc(
    fs.userPath(uid, "review_transactions", id),
    { status: "rejected", resolved_at: new Date().toISOString() },
    true,
  );
  return c.json({ ok: true });
}
