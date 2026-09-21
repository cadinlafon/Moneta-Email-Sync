import type { Context } from "hono";
import type { AppContext } from "../middleware";
import { firestoreClientFromEnv } from "../firestore";
import { getConnection, setSyncFrequency } from "../connection";
import type { SyncFrequency } from "../types";

const VALID_FREQUENCIES = new Set<SyncFrequency>([
  "manual",
  "5min",
  "10min",
  "15min",
  "30min",
  "hourly",
  "2h",
  "daily",
  "custom",
]);

const MIN_CUSTOM_MINUTES = 5;
const MAX_CUSTOM_MINUTES = 10080; // 7 days

/**
 * POST /email/schedule — body: { frequency: SyncFrequency, customMinutes?: number }
 * customMinutes is required (5-10080) when frequency is "custom", ignored otherwise.
 */
export async function scheduleHandler(c: Context<AppContext>) {
  const uid = c.get("uid");
  const body = (await c.req.json().catch(() => ({}))) as {
    frequency?: unknown;
    customMinutes?: unknown;
  };
  const frequency = body.frequency;

  if (typeof frequency !== "string" || !VALID_FREQUENCIES.has(frequency as SyncFrequency)) {
    return c.json({ error: "Not a valid sync schedule." }, 400);
  }

  let customMinutes: number | undefined;
  if (frequency === "custom") {
    const raw = body.customMinutes;
    if (
      typeof raw !== "number" ||
      !Number.isFinite(raw) ||
      raw < MIN_CUSTOM_MINUTES ||
      raw > MAX_CUSTOM_MINUTES
    ) {
      return c.json(
        {
          error: `Custom interval must be between ${MIN_CUSTOM_MINUTES} and ${MAX_CUSTOM_MINUTES} minutes.`,
        },
        400,
      );
    }
    customMinutes = Math.round(raw);
  }

  const fs = firestoreClientFromEnv(c.env);
  const connection = await getConnection(fs, uid);
  if (!connection) return c.json({ error: "No email account connected" }, 400);

  await setSyncFrequency(fs, uid, frequency as SyncFrequency, customMinutes);
  return c.json({ ok: true });
}
