export type Env = {
  AI: Ai;
  ALLOWED_ORIGINS: string;
  CONFIDENCE_AUTO_IMPORT: string;
  CONFIDENCE_REVIEW: string;
  AI_MODEL: string;
  FIREBASE_SERVICE_ACCOUNT: string;
  FIREBASE_PROJECT_ID: string;
  TOKEN_ENCRYPTION_KEY: string;
};

export type TransactionType = "income" | "expense" | "reimbursement" | "refund" | "transfer";

/** What the AI extracted from one email, before confidence gating. */
export type ExtractedTransaction = {
  isTransaction: boolean;
  type: TransactionType | "other";
  amount: number | null;
  currency: string | null;
  date: string | null;
  merchant: string | null;
  description: string | null;
  institution: string | null;
  accountHint: string | null;
  confidence: number;
};

/** One row of Gmail search metadata, before the full body is fetched. */
export type EmailSummary = {
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  internalDate: string;
  /** IMAP UID within the INBOX — used to fetch the full body if this message is worth reading. */
  uid: number;
};

/** How often the scheduled cron trigger should sync this connection on its own. */
export type SyncFrequency =
  "manual" | "5min" | "10min" | "15min" | "30min" | "hourly" | "2h" | "daily" | "custom";

export type EmailConnection = {
  provider: "gmail";
  /** Temporary: Gmail via IMAP + an App Password, not OAuth — see worker/README.md. */
  auth_method: "app_password";
  email: string;
  status: "connected" | "error";
  app_password_encrypted: string;
  app_password_iv: string;
  sync_frequency: SyncFrequency;
  /** Minutes between syncs when sync_frequency is "custom"; null/unset otherwise. */
  custom_interval_minutes: number | null;
  /** IMAP folder/label to search — "INBOX" by default, or e.g. "[Gmail]/All Mail" or a custom label. */
  search_folder: string;
  /** Sender keywords matched against From — editable in Settings, defaults to DEFAULT_KNOWN_SENDERS. */
  search_senders: string[];
  /** Subject keywords — editable in Settings, defaults to DEFAULT_FINANCIAL_KEYWORDS. */
  search_keywords: string[];
  connected_at: string;
  last_synced_at: string | null;
  last_sync_error: string | null;
  emails_scanned_total: number;
  transactions_found_total: number;
  transactions_imported_total: number;
};

export type ReviewTransaction = {
  id: string;
  message_id: string;
  type: TransactionType;
  amount: number;
  currency: string;
  occurred_on: string;
  merchant: string | null;
  description: string | null;
  institution: string | null;
  category_id: string | null;
  account_id: string | null;
  email_subject: string;
  email_from: string;
  confidence: number;
  status: "pending" | "approved" | "rejected";
  created_at: string;
};
