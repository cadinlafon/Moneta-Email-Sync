import type { Context } from "hono";
import type { AppContext } from "../middleware";
import { firestoreClientFromEnv } from "../firestore";
import { getConnection } from "../connection";
import { DEFAULT_FINANCIAL_KEYWORDS, DEFAULT_KNOWN_SENDERS, DEFAULT_SEARCH_FOLDER } from "../gmail";

/** GET /email/status — connection + last sync summary for the Settings page. */
export async function statusHandler(c: Context<AppContext>) {
  const uid = c.get("uid");
  const fs = firestoreClientFromEnv(c.env);
  const connection = await getConnection(fs, uid);

  if (!connection) {
    return c.json({ status: "not_connected" });
  }

  return c.json({
    status: connection.status,
    email: connection.email,
    provider: connection.provider,
    lastSyncedAt: connection.last_synced_at,
    lastSyncError: connection.last_sync_error,
    emailsScannedTotal: connection.emails_scanned_total,
    transactionsFoundTotal: connection.transactions_found_total,
    transactionsImportedTotal: connection.transactions_imported_total,
    syncFrequency: connection.sync_frequency ?? "manual",
    customIntervalMinutes: connection.custom_interval_minutes ?? null,
    searchFolder: connection.search_folder ?? DEFAULT_SEARCH_FOLDER,
    searchSenders: connection.search_senders ?? DEFAULT_KNOWN_SENDERS,
    searchKeywords: connection.search_keywords ?? DEFAULT_FINANCIAL_KEYWORDS,
  });
}
