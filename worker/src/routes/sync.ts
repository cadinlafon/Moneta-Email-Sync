import type { Context } from "hono";
import type { AppContext } from "../middleware";
import { firestoreClientFromEnv } from "../firestore";
import { getConnection } from "../connection";
import { runEmailSync } from "../sync-core";

/** POST /email/sync */
export async function syncHandler(c: Context<AppContext>) {
  const uid = c.get("uid");
  const fs = firestoreClientFromEnv(c.env);

  const connection = await getConnection(fs, uid);
  if (!connection) return c.json({ error: "No email account connected" }, 400);

  try {
    const result = await runEmailSync(c.env, fs, uid, connection);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[worker] sync failed", message);
    await fs
      .setDoc(
        fs.userPath(uid, "email_connections", "gmail"),
        { status: "error", last_sync_error: message },
        true,
      )
      .catch(() => undefined);
    return c.json({ error: "We couldn't finish syncing your email. Please try again." }, 502);
  }
}
