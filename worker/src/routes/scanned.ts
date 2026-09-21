import type { Context } from "hono";
import type { AppContext } from "../middleware";
import { firestoreClientFromEnv } from "../firestore";

const MAX_SCANNED_RESULTS = 100;

/** GET /email/scanned — the most recent emails the Worker has looked at, for the "which emails" view. */
export async function listScannedHandler(c: Context<AppContext>) {
  const uid = c.get("uid");
  const fs = firestoreClientFromEnv(c.env);
  const docs = await fs.listDocs(fs.userPath(uid, "processed_emails"), {
    orderBy: "processed_at desc",
    limit: MAX_SCANNED_RESULTS,
  });

  const items = docs.map((d) => ({
    id: d.id,
    from: String(d.data.from ?? ""),
    subject: String(d.data.subject ?? "(no subject)"),
    outcome: String(d.data.outcome ?? "ignored"),
    processedAt: String(d.data.processed_at ?? ""),
  }));

  return c.json({ items });
}
