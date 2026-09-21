/** Known financial institutions — a starting point, not an exhaustive allowlist (see DEFAULT_FINANCIAL_KEYWORDS). */
export const DEFAULT_KNOWN_SENDERS = [
  "chase",
  "cash.app",
  "square",
  "paypal",
  "venmo",
  "bankofamerica",
  "wellsfargo",
  "capitalone",
  "americanexpress",
  "discover",
  "citi",
  "citibank",
  "apple",
  "amazon",
];

export const DEFAULT_FINANCIAL_KEYWORDS = [
  "payment",
  "purchase",
  "transaction",
  "receipt",
  "deposit",
  "withdrawal",
  "transfer",
  "payment received",
  "payment sent",
  "debit",
  "credit",
  "refund",
  "subscription",
  "invoice",
  "order confirmation",
];

export const DEFAULT_SEARCH_FOLDER = "INBOX";

/**
 * Builds a Gmail search query from the user's own sender/keyword lists (see
 * Settings → Email Connection → Search settings) — casts a wide net (any
 * listed sender OR any listed keyword in the subject) without hard-locking
 * anyone to a fixed allowlist. Same syntax Gmail's own search box uses; also
 * accepted by IMAP's non-standard X-GM-RAW extension (see imap-gmail.ts).
 * Falls back to the defaults if both lists somehow end up empty, so a sync
 * never degrades into scanning an entire, unfiltered folder.
 */
export function buildFinancialSearchQuery(
  sinceDate: Date | null,
  senders: string[],
  keywords: string[],
): string {
  const effectiveSenders = senders.length > 0 ? senders : DEFAULT_KNOWN_SENDERS;
  const effectiveKeywords = keywords.length > 0 ? keywords : DEFAULT_FINANCIAL_KEYWORDS;
  const senderClause = effectiveSenders.map((s) => `from:${s}`).join(" OR ");
  const keywordClause = effectiveKeywords.map((k) => `subject:"${k}"`).join(" OR ");
  const clauses = [senderClause, keywordClause].filter(Boolean).join(" OR ");
  const dateClause = sinceDate ? ` after:${toGmailDate(sinceDate)}` : "";
  return `(${clauses}) -category:promotions -category:social${dateClause}`;
}

function toGmailDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}
