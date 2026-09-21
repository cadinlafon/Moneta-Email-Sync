import type { Env, EmailConnection, EmailSummary, ReviewTransaction, TransactionType } from "./types";
import type { FirestoreClient } from "./firestore";
import { getDecryptedAppPassword } from "./connection";
import { GmailImapSession } from "./imap-gmail";
import { extractTransactionFromEmail } from "./ai";
import { isFuzzyDuplicate, markMessageProcessed, messageAlreadyProcessed } from "./dedupe";
import { matchCategory } from "./categorize";
import { matchAccount } from "./account-match";
import type { DuplicateCandidate } from "./dedupe";
import { DEFAULT_FINANCIAL_KEYWORDS, DEFAULT_KNOWN_SENDERS, DEFAULT_SEARCH_FOLDER } from "./gmail";

const MAX_MESSAGES_PER_SYNC = 50;

export type SyncResult = {
  emailsScanned: number;
  transactionsFound: number;
  imported: number;
  needsReview: number;
};

type MessageOutcome = "imported" | "review" | "ignored";

type ProcessContext = {
  env: Env;
  fs: FirestoreClient;
  uid: string;
  categories: { id: string; name: string; kind: string }[];
  accounts: { id: string; name: string }[];
  duplicateCandidates: DuplicateCandidate[];
  autoImportThreshold: number;
  reviewThreshold: number;
};

/**
 * Classifies and files one already-fetched message — the shared core of both
 * a normal sync pass and a one-off "reprocess this email" retry. Always ends
 * by recording an outcome in processed_emails (overwriting any prior one),
 * so a retry that changes its mind fully replaces the earlier verdict.
 */
async function processMessage(
  ctx: ProcessContext,
  msg: EmailSummary,
  body: string,
): Promise<{ outcome: MessageOutcome; reason: string }> {
  const { env, fs, uid } = ctx;
  const mark = (outcome: MessageOutcome) =>
    markMessageProcessed(fs, uid, msg.messageId, outcome, { from: msg.from, subject: msg.subject });

  const extracted = await extractTransactionFromEmail(env, {
    from: msg.from,
    subject: msg.subject,
    body,
  });

  if (!extracted.isTransaction || extracted.type === "other" || extracted.amount === null) {
    await mark("ignored");
    return { outcome: "ignored", reason: "The AI didn't read this as a real transaction." };
  }
  if (extracted.confidence < ctx.reviewThreshold) {
    await mark("ignored");
    return {
      outcome: "ignored",
      reason: `Confidence too low (${extracted.confidence.toFixed(2)} < ${ctx.reviewThreshold}).`,
    };
  }

  const occurredOn =
    extracted.date ?? new Date(Number(msg.internalDate)).toISOString().slice(0, 10);
  const type = extracted.type as TransactionType;
  const candidate: DuplicateCandidate = {
    type,
    amount: extracted.amount,
    occurred_on: occurredOn,
    merchant: extracted.merchant,
  };

  if (isFuzzyDuplicate(candidate, ctx.duplicateCandidates)) {
    await mark("ignored");
    return { outcome: "ignored", reason: "Looked like a duplicate of an existing transaction." };
  }
  ctx.duplicateCandidates.push(candidate);

  const categoryId = matchCategory(
    `${extracted.merchant ?? ""} ${extracted.description ?? ""}`,
    ctx.categories,
    type === "expense" ? "expense" : "income",
  );
  const accountId = matchAccount(extracted.institution, extracted.accountHint, ctx.accounts);

  if (extracted.confidence >= ctx.autoImportThreshold) {
    const transactionRef = crypto.randomUUID();
    const delta =
      type === "expense" ? -extracted.amount : type === "transfer" ? 0 : extracted.amount;
    await fs.createTransactionWithBalanceUpdate(uid, accountId, delta, transactionRef, {
      account_id: accountId,
      to_account_id: null,
      category_id: categoryId,
      type,
      amount: extracted.amount,
      occurred_on: occurredOn,
      description: extracted.description ?? extracted.merchant,
      merchant: extracted.merchant,
      notes: `Imported from email — ${msg.subject}`,
      receipt_url: null,
      created_at: new Date().toISOString(),
      email_message_id: msg.messageId,
    });
    await mark("imported");
    return { outcome: "imported", reason: "Imported directly." };
  }

  const reviewItem: Omit<ReviewTransaction, "id"> = {
    message_id: msg.messageId,
    type,
    amount: extracted.amount,
    currency: extracted.currency ?? "USD",
    occurred_on: occurredOn,
    merchant: extracted.merchant,
    description: extracted.description,
    institution: extracted.institution,
    category_id: categoryId,
    account_id: accountId,
    email_subject: msg.subject,
    email_from: msg.from,
    confidence: extracted.confidence,
    status: "pending",
    created_at: new Date().toISOString(),
  };
  await fs.setDoc(fs.userPath(uid, "review_transactions", crypto.randomUUID()), reviewItem, false);
  await mark("review");
  return { outcome: "review", reason: "Sent to Needs Review." };
}

type RawDoc = { id: string; data: Record<string, unknown> };

/**
 * `excludeMessageId` leaves the given message's own prior transaction/review
 * item out of the duplicate-candidate list — used by reprocessMessage, which
 * is about to delete and replace that exact artifact, so it shouldn't be
 * flagged as a duplicate of itself.
 */
async function loadProcessContext(
  env: Env,
  fs: FirestoreClient,
  uid: string,
  excludeMessageId?: string,
): Promise<
  Omit<ProcessContext, "duplicateCandidates"> & {
    duplicateCandidates: DuplicateCandidate[];
    existingTransactions: RawDoc[];
    pendingReview: RawDoc[];
  }
> {
  const [categories, accounts, existingTransactions, pendingReview] = await Promise.all([
    fs.listDocs(fs.userPath(uid, "categories")),
    fs.listDocs(fs.userPath(uid, "accounts")),
    fs.listDocs(fs.userPath(uid, "transactions")),
    fs.listDocs(fs.userPath(uid, "review_transactions")),
  ]);

  const duplicateCandidates: DuplicateCandidate[] = [
    ...existingTransactions
      .filter((t) => t.data.email_message_id !== excludeMessageId)
      .map((t) => ({
        type: String(t.data.type),
        amount: Number(t.data.amount),
        occurred_on: String(t.data.occurred_on),
        merchant: (t.data.merchant as string | null) ?? null,
      })),
    ...pendingReview
      .filter((r) => r.data.status === "pending" && r.data.message_id !== excludeMessageId)
      .map((r) => ({
        type: String(r.data.type),
        amount: Number(r.data.amount),
        occurred_on: String(r.data.occurred_on),
        merchant: (r.data.merchant as string | null) ?? null,
      })),
  ];

  return {
    env,
    fs,
    uid,
    categories: categories.map((cat) => ({
      id: cat.id,
      name: String(cat.data.name),
      kind: String(cat.data.kind),
    })),
    accounts: accounts.map((a) => ({ id: a.id, name: String(a.data.name) })),
    duplicateCandidates,
    existingTransactions,
    pendingReview,
    autoImportThreshold: Number(env.CONFIDENCE_AUTO_IMPORT),
    reviewThreshold: Number(env.CONFIDENCE_REVIEW),
  };
}

/**
 * One full sync pass for one user's connection — search, AI-extract, dedupe,
 * import/review, update counters. Shared by the manual "Sync Now" HTTP route
 * and the scheduled cron trigger; callers are responsible for catching
 * errors and flipping the connection's status to "error".
 */
export async function runEmailSync(
  env: Env,
  fs: FirestoreClient,
  uid: string,
  connection: EmailConnection,
): Promise<SyncResult> {
  // Older connections predate these fields — fall back to the same defaults
  // a fresh connection would have started with.
  const folder = connection.search_folder ?? DEFAULT_SEARCH_FOLDER;
  const senders = connection.search_senders ?? DEFAULT_KNOWN_SENDERS;
  const keywords = connection.search_keywords ?? DEFAULT_FINANCIAL_KEYWORDS;

  const appPassword = await getDecryptedAppPassword(env, connection);
  const session = await GmailImapSession.open(connection.email, appPassword, folder);

  try {
    const ctx = await loadProcessContext(env, fs, uid);

    // A full day of overlap, not the exact last-sync instant: Gmail's
    // "after:" search operator works at day granularity and syncing every
    // few minutes means last_synced_at is almost always "today" — if
    // "after:<today>" excludes today's own messages (server-dependent),
    // every sync would re-derive the same excluded date and permanently
    // miss anything arriving today. The existing per-message dedupe
    // (messageAlreadyProcessed) makes re-scanning a day of overlap safe.
    const sinceDate = connection.last_synced_at
      ? new Date(new Date(connection.last_synced_at).getTime() - 24 * 60 * 60 * 1000)
      : null;
    const messages = await session.search(sinceDate, MAX_MESSAGES_PER_SYNC, senders, keywords);

    let found = 0;
    let imported = 0;
    let needsReview = 0;

    for (const msg of messages) {
      if (await messageAlreadyProcessed(fs, uid, msg.messageId)) {
        continue;
      }

      const body = await session.fetchBody(msg.uid);
      const { outcome } = await processMessage(ctx, msg, body);
      if (outcome === "imported") {
        found++;
        imported++;
      } else if (outcome === "review") {
        found++;
        needsReview++;
      }
    }

    await fs.setDoc(
      fs.userPath(uid, "email_connections", "gmail"),
      {
        status: "connected",
        last_synced_at: new Date().toISOString(),
        last_sync_error: null,
        emails_scanned_total: connection.emails_scanned_total + messages.length,
        transactions_found_total: connection.transactions_found_total + found,
        transactions_imported_total: connection.transactions_imported_total + imported,
      },
      true,
    );

    return { emailsScanned: messages.length, transactionsFound: found, imported, needsReview };
  } finally {
    await session.close().catch(() => undefined);
  }
}

/**
 * Re-runs classification on one specific already-scanned email, bypassing
 * the "already processed" dedupe check that normally makes a verdict
 * permanent — the escape hatch for a message the AI got wrong the first
 * time (e.g. marked "not a transaction" when it clearly was one). Relocates
 * the message by re-searching (IMAP UIDs aren't persisted between syncs) and
 * overwrites its processed_emails record with the new verdict.
 */
export async function reprocessMessage(
  env: Env,
  fs: FirestoreClient,
  uid: string,
  connection: EmailConnection,
  messageId: string,
): Promise<{ found: boolean; outcome?: MessageOutcome; reason?: string }> {
  const folder = connection.search_folder ?? DEFAULT_SEARCH_FOLDER;
  const senders = connection.search_senders ?? DEFAULT_KNOWN_SENDERS;
  const keywords = connection.search_keywords ?? DEFAULT_FINANCIAL_KEYWORDS;

  const appPassword = await getDecryptedAppPassword(env, connection);
  const session = await GmailImapSession.open(connection.email, appPassword, folder);

  try {
    // No since-date floor and a generous cap — this message could be from
    // well before the connection's last sync point.
    const messages = await session.search(null, 500, senders, keywords);
    const msg = messages.find((m) => m.messageId === messageId);
    if (!msg) return { found: false };

    const ctx = await loadProcessContext(env, fs, uid, messageId);

    // Supersede whatever this message previously created — otherwise
    // rechecking an already-"imported" or already-"review" email would
    // leave the old (wrong) one in place and add a second, correct one
    // alongside it.
    const priorTransaction = ctx.existingTransactions.find(
      (t) => t.data.email_message_id === messageId,
    );
    if (priorTransaction) {
      const type = String(priorTransaction.data.type);
      const amount = Number(priorTransaction.data.amount);
      const accountId = (priorTransaction.data.account_id as string | null) ?? null;
      const delta = type === "expense" ? -amount : type === "transfer" ? 0 : amount;
      await fs.deleteTransactionWithBalanceUpdate(uid, accountId, delta, priorTransaction.id);
    }
    const priorReview = ctx.pendingReview.find((r) => r.data.message_id === messageId);
    if (priorReview) {
      await fs.deleteDoc(fs.userPath(uid, "review_transactions", priorReview.id));
    }

    const body = await session.fetchBody(msg.uid);
    const result = await processMessage(ctx, msg, body);
    return { found: true, ...result };
  } finally {
    await session.close().catch(() => undefined);
  }
}
