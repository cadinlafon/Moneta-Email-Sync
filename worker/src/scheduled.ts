import type { Env, EmailConnection, SyncFrequency } from "./types";
import { firestoreClientFromEnv } from "./firestore";
import { runEmailSync } from "./sync-core";

const INTERVAL_MS: Record<Exclude<SyncFrequency, "manual" | "custom">, number> = {
  "5min": 5 * 60 * 1000,
  "10min": 10 * 60 * 1000,
  "15min": 15 * 60 * 1000,
  "30min": 30 * 60 * 1000,
  hourly: 60 * 60 * 1000,
  "2h": 2 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

/**
 * Runs on the cron trigger (see wrangler.toml's [triggers]). Checks every
 * user's email connection at once via a Firestore collection-group query —
 * there's no single uid to scope this to — and syncs whichever ones are due
 * for their chosen schedule. One user's failure never blocks the rest.
 */
export async function handleScheduled(env: Env): Promise<void> {
  const fs = firestoreClientFromEnv(env);
  const rows = await fs.listCollectionGroup("email_connections");
  const now = Date.now();

  for (const row of rows) {
    const connection = row.data as EmailConnection;
    const frequency = connection.sync_frequency ?? "manual";
    if (frequency === "manual") continue;

    const interval =
      frequency === "custom"
        ? connection.custom_interval_minutes
          ? connection.custom_interval_minutes * 60 * 1000
          : undefined
        : INTERVAL_MS[frequency];
    if (!interval) continue;

    const lastSyncedAt = connection.last_synced_at
      ? new Date(connection.last_synced_at).getTime()
      : 0;
    if (now - lastSyncedAt < interval) continue;

    try {
      await runEmailSync(env, fs, row.uid, connection);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[worker] scheduled sync failed", row.uid, message);
      await fs
        .setDoc(
          fs.userPath(row.uid, "email_connections", "gmail"),
          { status: "error", last_sync_error: message },
          true,
        )
        .catch(() => undefined);
    }
  }
}
