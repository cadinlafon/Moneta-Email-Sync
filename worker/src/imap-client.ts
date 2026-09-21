import { connect } from "cloudflare:sockets";

/**
 * A minimal IMAP4rev1 client — just enough to LOGIN, SELECT INBOX, and run
 * UID SEARCH / UID FETCH against Gmail. Not a general-purpose IMAP library:
 * no IDLE, no MIME structure parsing beyond what imap-gmail.ts needs, no
 * retry/reconnect logic. This is a temporary stand-in for real Gmail OAuth
 * (an app password instead) — see worker/README.md.
 */
export class ImapConnection {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = new Uint8Array(0);
  private tagCounter = 0;

  private constructor(private socket: ReturnType<typeof connect>) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  static async connectTls(hostname: string, port: number): Promise<ImapConnection> {
    const socket = connect({ hostname, port }, { secureTransport: "on", allowHalfOpen: false });
    const conn = new ImapConnection(socket);
    await conn.readLine(); // server greeting, e.g. "* OK Gimap ready"
    return conn;
  }

  private nextTag(): string {
    this.tagCounter += 1;
    return `A${this.tagCounter}`;
  }

  private async fill(): Promise<boolean> {
    const { value, done } = await this.reader.read();
    if (done || !value) return false;
    const merged = new Uint8Array(this.buffer.length + value.length);
    merged.set(this.buffer);
    merged.set(value, this.buffer.length);
    this.buffer = merged;
    return true;
  }

  private findCrlf(): number {
    for (let i = 0; i < this.buffer.length - 1; i++) {
      if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) return i;
    }
    return -1;
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const idx = this.findCrlf();
      if (idx !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        return new TextDecoder().decode(line);
      }
      if (!(await this.fill())) throw new Error("IMAP connection closed unexpectedly");
    }
  }

  private async readExact(n: number): Promise<Uint8Array> {
    while (this.buffer.length < n) {
      if (!(await this.fill())) throw new Error("IMAP connection closed unexpectedly");
    }
    const data = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return data;
  }

  private async send(line: string): Promise<void> {
    await this.writer.write(new TextEncoder().encode(`${line}\r\n`));
  }

  /**
   * Sends one tagged command and reads every response line up to the
   * matching tagged completion. A `{N}` literal marker at the end of a line
   * is resolved by reading exactly N raw bytes (appended to `literals`, in
   * order) and then continuing to read the remainder of that logical line —
   * a literal can itself be followed by more text before a real CRLF.
   */
  private async command(commandText: string): Promise<{
    ok: boolean;
    statusLine: string;
    untagged: string[];
    literals: Uint8Array[];
  }> {
    const tag = this.nextTag();
    await this.send(`${tag} ${commandText}`);
    const untagged: string[] = [];
    const literals: Uint8Array[] = [];
    for (;;) {
      let line = await this.readLine();
      for (;;) {
        const m = /\{(\d+)\}$/.exec(line);
        if (!m) break;
        const n = Number(m[1]);
        const data = await this.readExact(n);
        literals.push(data);
        line = `${line.slice(0, m.index)}{literal ${literals.length - 1}}${await this.readLine()}`;
      }
      if (line.startsWith(`${tag} `)) {
        return { ok: /^\S+\s+OK\b/i.test(line), statusLine: line, untagged, literals };
      }
      untagged.push(line);
    }
  }

  async login(email: string, appPassword: string): Promise<void> {
    const res = await this.command(
      `LOGIN ${quoteImapString(email)} ${quoteImapString(appPassword)}`,
    );
    if (!res.ok) throw new Error("Gmail rejected that email and app password.");
  }

  /** Selects any folder/label — "INBOX", "[Gmail]/All Mail", a custom label, etc. */
  async selectFolder(name: string): Promise<void> {
    const res = await this.command(`SELECT ${quoteImapString(name)}`);
    if (!res.ok) throw new Error(`Could not open the "${name}" folder in Gmail.`);
  }

  /** Gmail's non-standard X-GM-RAW search extension accepts the same query syntax as Gmail's own search box. */
  async searchGmailRaw(query: string): Promise<number[]> {
    const res = await this.command(`UID SEARCH X-GM-RAW ${quoteImapString(query)}`);
    if (!res.ok) throw new Error("Gmail search failed.");
    const ids: number[] = [];
    for (const line of res.untagged) {
      const m = /^\*\s+SEARCH(.*)$/.exec(line);
      if (!m) continue;
      for (const part of m[1].trim().split(/\s+/)) {
        if (part) ids.push(Number(part));
      }
    }
    return ids;
  }

  private static readonly HEADER_FIELDS =
    "HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING)";

  /** Just the handful of headers used for listing/classifying a message — cheap, no body bytes. */
  async fetchHeader(uid: number): Promise<string> {
    const res = await this.command(`UID FETCH ${uid} (BODY.PEEK[${ImapConnection.HEADER_FIELDS}])`);
    if (!res.ok) throw new Error("Could not fetch that email.");
    const [headerBytes] = res.literals;
    if (!headerBytes) throw new Error("Unexpected FETCH response shape.");
    return new TextDecoder().decode(headerBytes);
  }

  /**
   * The raw MIME text body — used once a message is confirmed worth reading
   * in full. Fetched as its own request rather than combined with the
   * header fields in one FETCH command: IMAP servers aren't guaranteed to
   * return multiple requested data items in the order they were requested
   * (Gmail in particular returns BODY[TEXT] before BODY[HEADER.FIELDS...]),
   * and positionally destructuring two literals silently swapped header and
   * body content — every email's "body" sent to the AI was actually just
   * its header block.
   */
  async fetchBodyText(uid: number): Promise<Uint8Array> {
    const res = await this.command(`UID FETCH ${uid} (BODY.PEEK[TEXT])`);
    if (!res.ok) throw new Error("Could not fetch that email.");
    const [bodyBytes] = res.literals;
    if (!bodyBytes) throw new Error("Unexpected FETCH response shape.");
    return bodyBytes;
  }

  async logout(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } catch {
      // best-effort — we're closing the socket either way
    } finally {
      try {
        this.writer.releaseLock();
      } catch {
        /* already released */
      }
      try {
        this.reader.releaseLock();
      } catch {
        /* already released */
      }
      await this.socket.close().catch(() => undefined);
    }
  }
}

function quoteImapString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
