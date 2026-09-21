import type { Env, EmailConnection, SyncFrequency } from "./types";
import type { FirestoreClient } from "./firestore";
import { decryptSecret, encryptSecret } from "./crypto";
import { DEFAULT_FINANCIAL_KEYWORDS, DEFAULT_KNOWN_SENDERS, DEFAULT_SEARCH_FOLDER } from "./gmail";

const CONNECTION_DOC = "gmail";

export async function getConnection(
  fs: FirestoreClient,
  uid: string,
): Promise<EmailConnection | null> {
  const doc = await fs.getDoc(fs.userPath(uid, "email_connections", CONNECTION_DOC));
  return doc ? (doc.data as EmailConnection) : null;
}

export async function saveConnection(
  fs: FirestoreClient,
  uid: string,
  env: Env,
  email: string,
  appPassword: string,
): Promise<void> {
  const { ciphertext, iv } = await encryptSecret(appPassword, env.TOKEN_ENCRYPTION_KEY);
  const connection: EmailConnection = {
    provider: "gmail",
    auth_method: "app_password",
    email,
    status: "connected",
    app_password_encrypted: ciphertext,
    app_password_iv: iv,
    sync_frequency: "manual",
    custom_interval_minutes: null,
    search_folder: DEFAULT_SEARCH_FOLDER,
    search_senders: [...DEFAULT_KNOWN_SENDERS],
    search_keywords: [...DEFAULT_FINANCIAL_KEYWORDS],
    connected_at: new Date().toISOString(),
    last_synced_at: null,
    last_sync_error: null,
    emails_scanned_total: 0,
    transactions_found_total: 0,
    transactions_imported_total: 0,
  };
  await fs.setDoc(fs.userPath(uid, "email_connections", CONNECTION_DOC), connection, true);
}

export async function disconnectConnection(fs: FirestoreClient, uid: string): Promise<void> {
  await fs.deleteDoc(fs.userPath(uid, "email_connections", CONNECTION_DOC));
}

export async function setSyncFrequency(
  fs: FirestoreClient,
  uid: string,
  frequency: SyncFrequency,
  customMinutes?: number,
): Promise<void> {
  await fs.setDoc(
    fs.userPath(uid, "email_connections", CONNECTION_DOC),
    {
      sync_frequency: frequency,
      custom_interval_minutes: frequency === "custom" ? (customMinutes ?? null) : null,
    },
    true,
  );
}

/**
 * Updates what a sync searches for. Also clears `last_synced_at` so the
 * next sync searches from the beginning under the new criteria — otherwise
 * a newly-added sender or keyword would only catch emails that arrive after
 * this change, missing anything already sitting in the folder. Firestore's
 * processed_emails dedupe still skips anything already looked at, so this
 * is safe to do on every change.
 */
export async function updateSearchSettings(
  fs: FirestoreClient,
  uid: string,
  settings: { folder: string; senders: string[]; keywords: string[] },
): Promise<void> {
  await fs.setDoc(
    fs.userPath(uid, "email_connections", CONNECTION_DOC),
    {
      search_folder: settings.folder,
      search_senders: settings.senders,
      search_keywords: settings.keywords,
      last_synced_at: null,
    },
    true,
  );
}

/** Decrypts the stored app password so a sync can open an IMAP session with it. */
export async function getDecryptedAppPassword(
  env: Env,
  connection: EmailConnection,
): Promise<string> {
  return decryptSecret(
    connection.app_password_encrypted,
    connection.app_password_iv,
    env.TOKEN_ENCRYPTION_KEY,
  );
}
