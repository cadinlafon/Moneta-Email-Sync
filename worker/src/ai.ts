import type { Env, ExtractedTransaction } from "./types";

const VALID_TYPES = new Set(["income", "expense", "reimbursement", "refund", "transfer", "other"]);

const SYSTEM_PROMPT = `You are a financial email classifier for a personal finance app. You will be shown one email's sender, subject, and body text. Decide whether it describes an actual financial transaction (a purchase, payment sent or received, deposit, withdrawal, transfer, or refund) as opposed to a promotion, newsletter, statement summary, security alert, or unrelated message.

Respond with ONLY a single JSON object, no other text, matching exactly this shape:
{
  "isTransaction": boolean,
  "type": "income" | "expense" | "reimbursement" | "refund" | "transfer" | "other",
  "amount": number | null,
  "currency": string | null,
  "date": "YYYY-MM-DD" | null,
  "merchant": string | null,
  "description": string | null,
  "institution": string | null,
  "accountHint": string | null,
  "confidence": number
}

Rules:
- "expense" = money leaving the user's account to pay for something.
- "income" = money the user received (a deposit, a payment from another person, payroll).
- "refund" = money returned for a prior purchase.
- "transfer" = money moved between the user's own accounts.
- If the email is not a real transaction (e.g. a weekly summary, a promo, a security notice, a login alert), set isTransaction to false and confidence to how sure you are it is NOT a transaction.
- For a peer-to-peer payment (Cash App, Venmo, PayPal, Zelle, etc.), "merchant" is the other PERSON's name (who paid or was paid), not the payment app's name — put the payment app/service in "institution" instead.
- "description" should be the specific note, memo, or line-item the email states for this transaction (e.g. "for 1gal milk", "concert tickets", the order's item names) whenever one is present — don't just restate the transaction type or the email subject as the description.
- "accountHint" is only the last 4 digits or account nickname if the email states one, otherwise null.
- confidence is your own calibrated certainty, from 0 to 1, that the extracted fields (or the isTransaction:false determination) are correct.
- Never invent an amount, date, merchant, or description that is not stated in the email. If a field is not present, use null.
- Output only the JSON object.`;

function safeParseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toNumberOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Sends one email to Workers AI for classification/extraction and returns a
 * validated result. Never throws on a malformed model response — an invalid
 * or unparseable response is treated as "not a transaction, no confidence"
 * so a single bad AI response can't corrupt the sync.
 */
export async function extractTransactionFromEmail(
  env: Env,
  email: { from: string; subject: string; body: string },
): Promise<ExtractedTransaction> {
  // A genuinely unparseable model response (not an infra failure — see
  // below) is treated as "not a transaction" rather than aborting the sync,
  // since retrying the exact same input won't help and this can happen
  // occasionally with any model.
  const unparseableFallback: ExtractedTransaction = {
    isTransaction: false,
    type: "other",
    amount: null,
    currency: null,
    date: null,
    merchant: null,
    description: null,
    institution: null,
    accountHint: null,
    confidence: 0,
  };


  type AiRawResponse = {
    response?: unknown;
    choices?: { message?: { content?: string } }[];
  };

  let raw: AiRawResponse;
  try {
    raw = (await env.AI.run(env.AI_MODEL as keyof AiModels, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `From: ${email.from}\nSubject: ${email.subject}\n\n${email.body}`,
        },
      ],
      max_tokens: 400,
    })) as AiRawResponse;
  } catch (err) {
    // An infrastructure failure (bad/deprecated model, rate limit, outage)
    // is NOT the same thing as "the AI looked at this and it's not a
    // transaction" — conflating the two here previously meant a broken
    // model silently marked every single email as "ignored" for months
    // with no visible error anywhere. Throw instead, so this surfaces as a
    // real sync failure and the email stays eligible for a future retry.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[worker] Workers AI call failed", message);
    throw new Error(`Workers AI call failed: ${message}`);
  }

  // Different models shape their output differently: some put a JSON string
  // directly on `.response`, some (like the "-fast" chat-completion models)
  // return an already-parsed object there, and some only populate the
  // OpenAI-style `.choices[0].message.content` string. Handle all three.
  let parsed: Record<string, unknown> | null = null;
  if (raw.response && typeof raw.response === "object") {
    parsed = raw.response as Record<string, unknown>;
  } else if (typeof raw.response === "string") {
    parsed = safeParseJson(raw.response);
  } else if (typeof raw.choices?.[0]?.message?.content === "string") {
    parsed = safeParseJson(raw.choices[0].message.content);
  }

  if (!parsed) {
    console.error("[worker] Workers AI returned unparseable output", JSON.stringify(raw));
    return unparseableFallback;
  }

  const type =
    typeof parsed.type === "string" && VALID_TYPES.has(parsed.type) ? parsed.type : "other";
  const confidence = toNumberOrNull(parsed.confidence) ?? 0;

  return {
    isTransaction: parsed.isTransaction === true,
    type: type as ExtractedTransaction["type"],
    amount: toNumberOrNull(parsed.amount),
    currency: toStringOrNull(parsed.currency),
    date: toStringOrNull(parsed.date),
    merchant: toStringOrNull(parsed.merchant),
    description: toStringOrNull(parsed.description),
    institution: toStringOrNull(parsed.institution),
    accountHint: toStringOrNull(parsed.accountHint),
    confidence: Math.min(1, Math.max(0, confidence)),
  };
}
