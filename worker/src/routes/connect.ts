import type { Context } from "hono";
import type { AppContext } from "../middleware";
import { verifyGmailAppPassword } from "../imap-gmail";
import { saveConnection } from "../connection";
import { firestoreClientFromEnv } from "../firestore";

type ConnectBody = { email?: unknown; appPassword?: unknown };

/**
 * POST /email/connect — temporary app-password path (see worker/README.md):
 * takes the Gmail address + a Google App Password directly, verifies it by
 * logging into IMAP, and stores it (encrypted) if that succeeds. No OAuth
 * redirect, no Google Cloud project required.
 */
export async function connectHandler(c: Context<AppContext>) {
  const uid = c.get("uid");
  const body = (await c.req.json().catch(() => ({}))) as ConnectBody;
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const appPassword =
    typeof body.appPassword === "string" ? body.appPassword.replace(/\s+/g, "") : "";

  if (!email || !appPassword) {
    return c.json({ error: "Enter your Gmail address and app password." }, 400);
  }

  try {
    await verifyGmailAppPassword(email, appPassword);
  } catch (err) {
    console.error("[worker] imap login failed", err instanceof Error ? err.message : err);
    return c.json(
      { error: "Gmail rejected that email and app password. Double-check both and try again." },
      401,
    );
  }

  const fs = firestoreClientFromEnv(c.env);
  await saveConnection(fs, uid, c.env, email, appPassword);
  return c.json({ ok: true });
}
