/**
 * AES-GCM-256 sealing for everything the relay stores that came out of a
 * message body or subject. Key: DATA_KEY secret, base64 of 32 random bytes.
 * Envelope: `v1:` + base64url(iv || ciphertext+tag). The AAD binds a sealed
 * value to its row and column, so a value cannot be moved between rows.
 */

const PREFIX = "v1:";
const IV_BYTES = 12;

function fromBase64(value: string): Uint8Array {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function importDataKey(base64: string): Promise<CryptoKey> {
  const raw = fromBase64(base64.trim());
  if (raw.length !== 32) throw new Error("DATA_KEY must be base64 of exactly 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(plaintext),
  );
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), IV_BYTES);
  return PREFIX + toBase64Url(out);
}

export async function open(key: CryptoKey, envelope: string, aad: string): Promise<string> {
  if (!envelope.startsWith(PREFIX)) throw new Error("unknown envelope version");
  const bytes = fromBase64(envelope.slice(PREFIX.length));
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes.slice(0, IV_BYTES),
      additionalData: new TextEncoder().encode(aad),
    },
    key,
    bytes.slice(IV_BYTES),
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Constant-time token comparison. Both sides are hashed first so the compare
 * always runs over 32 bytes, whatever the presented token's length.
 */
export async function tokensEqual(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0 && expected.length > 0;
}
