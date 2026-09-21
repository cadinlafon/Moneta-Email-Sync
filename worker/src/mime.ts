/** Small, defensive MIME helpers for parsing a raw IMAP-fetched header block + body. */

export function unfoldHeaders(raw: string): string {
  return raw.replace(/\r\n[ \t]+/g, " ");
}

export function parseHeaderValue(unfolded: string, name: string): string | null {
  const re = new RegExp(`^${name}:\\s*(.*)$`, "im");
  const m = re.exec(unfolded);
  return m ? m[1].trim() : null;
}

function decodeQuotedPrintable(input: string): string {
  const withoutSoftBreaks = input.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < withoutSoftBreaks.length; i++) {
    const ch = withoutSoftBreaks[i];
    const hex = withoutSoftBreaks.slice(i + 1, i + 3);
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push((ch ?? "").charCodeAt(0));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeBase64(input: string): string {
  try {
    const bin = atob(input.replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function decodeByEncoding(raw: string, encoding: string | null): string {
  switch ((encoding ?? "").toLowerCase()) {
    case "base64":
      return decodeBase64(raw);
    case "quoted-printable":
      return decodeQuotedPrintable(raw);
    default:
      return raw;
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** e.g. `multipart/alternative; boundary="000000000000abc"` -> `000000000000abc`. */
function extractBoundary(contentType: string | null): string | null {
  if (!contentType) return null;
  const m = /boundary="?([^";]+)"?/i.exec(contentType);
  return m ? m[1] : null;
}

type MimePart = { headers: string; body: string };

function splitMultipart(body: string, boundary: string): MimePart[] {
  const marker = `--${boundary}`;
  const segments = body.split(marker);
  const parts: MimePart[] = [];
  for (const segment of segments) {
    const trimmed = segment.replace(/^\r\n/, "");
    if (!trimmed || trimmed.startsWith("--")) continue;
    const headerEnd = trimmed.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    parts.push({ headers: trimmed.slice(0, headerEnd), body: trimmed.slice(headerEnd + 4) });
  }
  return parts;
}

/**
 * Given a message's top-level headers and raw BODY[TEXT] bytes, returns the
 * best plain-text representation it can find — walking one or two levels of
 * multipart/* if needed. Defensive by design: any parsing hiccup falls back
 * to a best-effort strip-tags-and-return rather than throwing, since one
 * malformed email shouldn't ever break a sync.
 */
export function extractPlainText(topHeaders: string, bodyBytes: Uint8Array): string {
  const contentType = parseHeaderValue(topHeaders, "content-type");
  const transferEncoding = parseHeaderValue(topHeaders, "content-transfer-encoding");
  const rawBody = new TextDecoder().decode(bodyBytes);

  try {
    if (contentType && /multipart\//i.test(contentType)) {
      const boundary = extractBoundary(contentType);
      if (boundary) {
        const parts = splitMultipart(rawBody, boundary);
        const plainPart = parts.find((p) => /content-type:\s*text\/plain/i.test(p.headers));
        const htmlPart = parts.find((p) => /content-type:\s*text\/html/i.test(p.headers));

        const plainText = plainPart
          ? decodeByEncoding(
              plainPart.body,
              parseHeaderValue(unfoldHeaders(plainPart.headers), "content-transfer-encoding"),
            ).trim()
          : "";
        const htmlText = htmlPart
          ? stripHtml(
              decodeByEncoding(
                htmlPart.body,
                parseHeaderValue(unfoldHeaders(htmlPart.headers), "content-transfer-encoding"),
              ),
            ).trim()
          : "";

        if (plainText || htmlText) {
          // Many transactional emails (e.g. Cash App) put extra detail —
          // a payment memo, a transaction breakdown — only in the HTML
          // alternative, with a terse plain-text fallback that omits it.
          // Prefer whichever version actually carries more content instead
          // of always taking plain text.
          const best = htmlText.length > plainText.length * 1.2 ? htmlText : plainText || htmlText;
          return best.slice(0, 6000);
        }

        // A wrapping multipart/mixed around a multipart/alternative — recurse once.
        const nested = parts.find((p) => /content-type:\s*multipart\//i.test(p.headers));
        if (nested) {
          return extractPlainText(
            unfoldHeaders(nested.headers),
            new TextEncoder().encode(nested.body),
          );
        }
      }
    }

    const decoded = decodeByEncoding(rawBody, transferEncoding);
    if (contentType && /text\/html/i.test(contentType)) {
      return stripHtml(decoded).slice(0, 6000);
    }
    return decoded.slice(0, 6000);
  } catch {
    return stripHtml(rawBody).slice(0, 6000);
  }
}
