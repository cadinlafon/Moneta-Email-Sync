/**
 * Tries to associate an imported transaction with an existing manual
 * account by name/last-4 hint. Only returns a match when the evidence is
 * reasonably specific — otherwise leaves the transaction unassigned so the
 * user can pick the right account during review, rather than guessing.
 */
/** Lowercases and strips everything but letters/digits, so "Cash App", "CashApp" and "cash-app" all compare equal. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function matchAccount(
  institution: string | null,
  accountHint: string | null,
  accounts: Array<{ id: string; name: string }>,
): string | null {
  if (accounts.length === 0) return null;

  if (accountHint) {
    const digits = accountHint.replace(/\D/g, "");
    if (digits.length >= 3) {
      const byDigits = accounts.find((a) => a.name.replace(/\D/g, "").includes(digits));
      if (byDigits) return byDigits.id;
    }
  }

  if (institution) {
    const needle = normalize(institution);
    const matches = accounts.filter((a) => normalize(a.name).includes(needle));
    // Only trust this when it's unambiguous — e.g. exactly one "Chase" account.
    if (matches.length === 1) return matches[0]!.id;
  }

  return null;
}
