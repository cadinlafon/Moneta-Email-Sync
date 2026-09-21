import type { Context } from "hono";
import type { AppContext } from "../middleware";
import { firestoreClientFromEnv } from "../firestore";
import { getConnection, updateSearchSettings } from "../connection";

const MAX_LIST_LENGTH = 50;
const MAX_ITEM_LENGTH = 80;
const MAX_FOLDER_LENGTH = 200;

function sanitizeList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const cleaned = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0 && v.length <= MAX_ITEM_LENGTH);
  // De-dupe while preserving order.
  return [...new Set(cleaned)].slice(0, MAX_LIST_LENGTH);
}

/** POST /email/search-settings — body: { folder, senders, keywords } */
export async function searchSettingsHandler(c: Context<AppContext>) {
  const uid = c.get("uid");
  const body = (await c.req.json().catch(() => ({}))) as {
    folder?: unknown;
    senders?: unknown;
    keywords?: unknown;
  };

  const folder =
    typeof body.folder === "string" ? body.folder.trim().slice(0, MAX_FOLDER_LENGTH) : "";
  const senders = sanitizeList(body.senders);
  const keywords = sanitizeList(body.keywords);

  if (!folder || senders === null || keywords === null) {
    return c.json({ error: "That search configuration isn't valid." }, 400);
  }
  if (senders.length === 0 && keywords.length === 0) {
    return c.json({ error: "Add at least one sender or keyword to search for." }, 400);
  }

  const fs = firestoreClientFromEnv(c.env);
  const connection = await getConnection(fs, uid);
  if (!connection) return c.json({ error: "No email account connected" }, 400);

  await updateSearchSettings(fs, uid, { folder, senders, keywords });
  return c.json({ ok: true });
}
