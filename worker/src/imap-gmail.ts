import type { EmailSummary } from "./types";
import { ImapConnection } from "./imap-client";
import { extractPlainText, parseHeaderValue, unfoldHeaders } from "./mime";
import { buildFinancialSearchQuery } from "./gmail";

const IMAP_HOST = "imap.gmail.com";
const IMAP_PORT = 993;

function messageIdFromHeader(headerValue: string | null, fallbackUid: number): string {
  const raw = headerValue ?? `uid-${fallbackUid}`;
  return raw
    .replace(/[<>]/g, "")
    .replace(/[^\w.@-]/g, "_")
    .slice(0, 200);
}

/** One IMAP session against Gmail — open it once per sync, reuse it for the search and every fetch, then close it. */
export class GmailImapSession {
  private constructor(private conn: ImapConnection) {}

  static async open(email: string, appPassword: string, folder: string): Promise<GmailImapSession> {
    const conn = await ImapConnection.connectTls(IMAP_HOST, IMAP_PORT);
    try {
      await conn.login(email, appPassword);
      await conn.selectFolder(folder || "INBOX");
    } catch (err) {
      await conn.logout().catch(() => undefined);
      throw err;
    }
    return new GmailImapSession(conn);
  }

  /** Cheap pass: search + headers only, no message bodies fetched yet. */
  async search(
    sinceDate: Date | null,
    maxResults: number,
    senders: string[],
    keywords: string[],
  ): Promise<EmailSummary[]> {
    const query = buildFinancialSearchQuery(sinceDate, senders, keywords);
    const uids = await this.conn.searchGmailRaw(query);
    // UIDs increase monotonically with arrival — the highest ones are the newest.
    const capped = uids.slice(-maxResults);

    const summaries: EmailSummary[] = [];
    for (const uid of capped) {
      const header = unfoldHeaders(await this.conn.fetchHeader(uid));
      const dateHeader = parseHeaderValue(header, "date");
      const internalDate = dateHeader ? String(new Date(dateHeader).getTime()) : String(Date.now());
      summaries.push({
        messageId: messageIdFromHeader(parseHeaderValue(header, "message-id"), uid),
        threadId: String(uid),
        from: parseHeaderValue(header, "from") ?? "",
        subject: parseHeaderValue(header, "subject") ?? "",
        internalDate,
        uid,
      });
    }
    return summaries;
  }

  /**
   * The full body text for one message — only called for messages worth
   * reading in full. Two sequential requests over the one shared connection
   * (see fetchBodyText) rather than one combined FETCH.
   */
  async fetchBody(uid: number): Promise<string> {
    const header = await this.conn.fetchHeader(uid);
    const body = await this.conn.fetchBodyText(uid);
    return extractPlainText(unfoldHeaders(header), body);
  }

  async close(): Promise<void> {
    await this.conn.logout();
  }
}

/** Verifies an email + app password pair by logging in and straight back out — used by POST /email/connect. */
export async function verifyGmailAppPassword(email: string, appPassword: string): Promise<void> {
  const conn = await ImapConnection.connectTls(IMAP_HOST, IMAP_PORT);
  try {
    await conn.login(email, appPassword);
  } finally {
    await conn.logout().catch(() => undefined);
  }
}
