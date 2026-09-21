/**
 * Merchant/description keyword hints mapped to the kind of category name a
 * user is likely to already have (e.g. from Moneta's own default category
 * set). This never invents a category — it only looks up an existing one by
 * name; if the user doesn't have a matching category, the transaction is
 * left uncategorized rather than guessing.
 */
const KEYWORD_HINTS: Array<{ pattern: RegExp; categoryNames: string[] }> = [
  { pattern: /walmart|target|amazon|costco/i, categoryNames: ["shopping"] },
  { pattern: /shell|chevron|exxon|bp gas|fuel/i, categoryNames: ["fuel", "transportation", "gas"] },
  { pattern: /uber|lyft|transit|parking/i, categoryNames: ["transportation"] },
  {
    pattern: /mcdonald|starbucks|restaurant|doordash|grubhub|uber eats/i,
    categoryNames: ["restaurants", "food & dining", "food"],
  },
  { pattern: /grocery|safeway|kroger|whole foods|trader joe/i, categoryNames: ["groceries"] },
  {
    pattern: /netflix|spotify|hulu|disney\+|subscription/i,
    categoryNames: ["entertainment", "subscriptions"],
  },
  {
    pattern: /electric|water bill|utility|utilities|internet|phone bill/i,
    categoryNames: ["utilities", "internet & phone"],
  },
  { pattern: /payroll|salary|paycheck|direct deposit/i, categoryNames: ["salary", "income"] },
  { pattern: /rent|mortgage|landlord/i, categoryNames: ["rent", "housing"] },
];

/** Picks a category id by matching merchant/description text against the user's own categories. Returns null (Uncategorized) rather than guessing. */
export function matchCategory(
  text: string,
  categories: Array<{ id: string; name: string; kind: string }>,
  kind: "income" | "expense",
): string | null {
  const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));

  for (const hint of KEYWORD_HINTS) {
    if (!hint.pattern.test(text)) continue;
    for (const name of hint.categoryNames) {
      const match = byName.get(name);
      if (match && match.kind === kind) return match.id;
    }
  }
  return null;
}
