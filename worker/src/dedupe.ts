import type { FirestoreClient } from "./firestore";

export async function messageAlreadyProcessed(
  fs: FirestoreClient,
  uid: string,
  messageId: string,
): Promise<boolean> {
  const doc = await fs.getDoc(fs.userPath(uid, "processed_emails", messageId));
  return doc !== null;
}

export async function markMessageProcessed(
  fs: FirestoreClient,
  uid: string,
  messageId: string,
  outcome: "imported" | "review" | "ignored",
  meta: { from: string; subject: string },
): Promise<void> {
  await fs.setDoc(
    fs.userPath(uid, "processed_emails", messageId),
    {
      outcome,
      from: meta.from,
      subject: meta.subject,
      processed_at: new Date().toISOString(),
    },
    false,
  );
}

export type DuplicateCandidate = {
  type: string;
  amount: number;
  occurred_on: string;
  merchant: string | null;
};

/**
 * Catches the case a bank sends more than one email about the same
 * transaction (so message-id dedupe alone wouldn't catch it): same type,
 * same amount, dates within a day of each other, and a similar merchant.
 */
export function isFuzzyDuplicate(
  candidate: DuplicateCandidate,
  existing: DuplicateCandidate[],
): boolean {
  const candidateDate = Date.parse(candidate.occurred_on);
  return existing.some((e) => {
    if (e.type !== candidate.type) return false;
    if (Math.abs(e.amount - candidate.amount) > 0.01) return false;
    const dayDiff = Math.abs(Date.parse(e.occurred_on) - candidateDate) / 86400000;
    if (dayDiff > 1) return false;
    if (candidate.merchant && e.merchant) {
      const a = candidate.merchant.toLowerCase();
      const b = e.merchant.toLowerCase();
      return a.includes(b) || b.includes(a);
    }
    // No merchant on one side — same type/amount/day is already a strong signal.
    return true;
  });
}
