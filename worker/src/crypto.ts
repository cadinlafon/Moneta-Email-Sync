/** AES-GCM helpers for encrypting the Google refresh token before it's stored in Firestore. */

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = b64ToBytes(base64Key);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(
  plaintext: string,
  base64Key: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const buf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return { ciphertext: bytesToB64(new Uint8Array(buf)), iv: bytesToB64(iv) };
}

export async function decryptSecret(
  ciphertextB64: string,
  ivB64: string,
  base64Key: string,
): Promise<string> {
  const key = await importKey(base64Key);
  const iv = b64ToBytes(ivB64);
  const ciphertext = b64ToBytes(ciphertextB64);
  const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(buf);
}
