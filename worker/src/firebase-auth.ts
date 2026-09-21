import { decodeProtectedHeader, importX509, jwtVerify } from "jose";

const CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let certsCache: { certs: Record<string, string>; expiresAt: number } | null = null;

async function getCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (certsCache && certsCache.expiresAt > now) return certsCache.certs;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error("Could not fetch Firebase auth certs");
  const certs = (await res.json()) as Record<string, string>;
  // Google sends a Cache-Control max-age; fall back to 1 hour.
  const cacheControl = res.headers.get("cache-control") ?? "";
  const maxAgeMatch = /max-age=(\d+)/.exec(cacheControl);
  const ttlMs = (maxAgeMatch ? Number(maxAgeMatch[1]) : 3600) * 1000;
  certsCache = { certs, expiresAt: now + ttlMs };
  return certs;
}

export class AuthError extends Error {}

/**
 * Verifies a Firebase ID token the way Firebase's own Admin SDK does, using
 * Google's published certs — this Worker can't run the Node Admin SDK, so
 * verification is done directly against the JWT.
 */
export async function verifyFirebaseIdToken(token: string, projectId: string): Promise<string> {
  let kid: string | undefined;
  try {
    ({ kid } = decodeProtectedHeader(token));
  } catch {
    throw new AuthError("Malformed token");
  }
  if (!kid) throw new AuthError("Token missing key id");

  const certs = await getCerts();
  const pem = certs[kid];
  if (!pem) throw new AuthError("Unknown signing key");

  const publicKey = await importX509(pem, "RS256");
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });

  if (!payload.sub || typeof payload.sub !== "string") {
    throw new AuthError("Token missing subject");
  }
  return payload.sub;
}
