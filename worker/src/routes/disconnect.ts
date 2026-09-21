import type { Context } from "hono";
import type { AppContext } from "../middleware";
import { firestoreClientFromEnv } from "../firestore";
import { disconnectConnection } from "../connection";

/** POST /email/disconnect — removes the stored connection. Imported transactions and review history are kept. */
export async function disconnectHandler(c: Context<AppContext>) {
  const uid = c.get("uid");
  const fs = firestoreClientFromEnv(c.env);
  await disconnectConnection(fs, uid);
  return c.json({ ok: true });
}
