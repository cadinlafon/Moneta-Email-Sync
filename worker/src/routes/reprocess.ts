import type { Context } from "hono";
import type { AppContext } from "../middleware";
import { firestoreClientFromEnv } from "../firestore";
import { getConnection } from "../connection";
import { reprocessMessage } from "../sync-core";

/**
 * POST /email/reprocess — body: { messageId }. Re-runs classification on one
 * already-scanned email (see reprocessMessage) — the recovery path for a
 * message the AI got wrong the first time.
 */
export async function reprocessHandler(c: Context<AppContext>) {
  const uid = c.get("uid");
  const body = (await c.req.json().catch(() => ({}))) as { messageId?: unknown };
  const messageId = body.messageId;
  if (typeof messageId !== "string" || !messageId) {
    return c.json({ error: "messageId is required." }, 400);
  }

  const fs = firestoreClientFromEnv(c.env);
  const connection = await getConnection(fs, uid);
  if (!connection) return c.json({ error: "No email account connected" }, 400);

  try {
    const result = await reprocessMessage(c.env, fs, uid, connection, messageId);
    if (!result.found) {
      return c.json(
        { error: "Couldn't find that email in the mailbox anymore — it may have been deleted." },
        404,
      );
    }
    return c.json({ outcome: result.outcome, reason: result.reason });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Reprocessing failed.";
    console.error("[worker] reprocess failed", uid, message);
    return c.json({ error: message }, 500);
  }
}
