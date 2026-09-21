import type { Context, Next } from "hono";
import type { Env } from "./types";
import { AuthError, verifyFirebaseIdToken } from "./firebase-auth";

export type AppContext = { Bindings: Env; Variables: { uid: string } };

/**
 * Verifies the Firebase ID token on every protected request and derives the
 * user id from it — the frontend's own claims about "who this is" are never
 * trusted, only the verified token's `sub` claim is.
 */
export async function requireAuth(c: Context<AppContext>, next: Next) {
  const header = c.req.header("authorization") ?? c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing authorization header" }, 401);
  }
  const token = header.slice("Bearer ".length);
  try {
    const uid = await verifyFirebaseIdToken(token, c.env.FIREBASE_PROJECT_ID);
    c.set("uid", uid);
  } catch (err) {
    if (err instanceof AuthError) return c.json({ error: "Invalid or expired session" }, 401);
    console.error("[worker] token verification failed", err instanceof Error ? err.message : err);
    return c.json({ error: "Could not verify your session" }, 401);
  }
  await next();
}

export function corsOrigin(env: Env, requestOrigin: string | undefined): string | null {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return null;
}
