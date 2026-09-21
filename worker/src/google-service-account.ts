import { SignJWT, importPKCS8 } from "jose";

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id: string;
};

let cachedAccount: ServiceAccount | null = null;
let cachedToken: { token: string; expiresAt: number } | null = null;

export function parseServiceAccount(raw: string): ServiceAccount {
  if (cachedAccount) return cachedAccount;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON");
  }
  const sa = json as Partial<ServiceAccount>;
  if (!sa.client_email || !sa.private_key || !sa.project_id) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is missing required fields");
  }
  cachedAccount = {
    client_email: sa.client_email,
    private_key: sa.private_key,
    token_uri: sa.token_uri ?? "https://oauth2.googleapis.com/token",
    project_id: sa.project_id,
  };
  return cachedAccount;
}

/**
 * Mints a short-lived Google OAuth2 access token for the service account,
 * scoped to Firestore. Cached in-memory for the life of the isolate.
 */
export async function getServiceAccountAccessToken(serviceAccountRaw: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 30) return cachedToken.token;

  const sa = parseServiceAccount(serviceAccountRaw);
  const privateKey = await importPKCS8(sa.private_key, "RS256");
  const jwt = await new SignJWT({ scope: "https://www.googleapis.com/auth/datastore" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(sa.client_email)
    .setAudience(sa.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    console.error("[worker] service account token exchange failed", res.status);
    throw new Error("Could not authenticate with Firestore");
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: now + data.expires_in };
  return data.access_token;
}
