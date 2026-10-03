import { pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * The secondary backup password (ARCHITECTURE.md section 8, "Access"). Only
 * its PBKDF2-SHA256 hash is configured (UI_PASSWORD_HASH), in the format
 * shared with the sibling projects:
 *
 *   pbkdf2$sha256$<iterations>$<salt base64url>$<hash base64url>
 *
 * `scripts/hash-password.ts` generates a password and its hash.
 */

const derive = promisify(pbkdf2);

export const DEFAULT_ITERATIONS = 600_000;
/** Hashes weaker than this are refused outright. */
export const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;

export async function hashPassword(
  password: string,
  options: { iterations?: number; salt?: Buffer } = {},
): Promise<string> {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const salt = options.salt ?? randomBytes(16);
  const hash = await derive(password, salt, iterations, 32, "sha256");
  return `pbkdf2$sha256$${String(iterations)}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

interface ParsedHash {
  iterations: number;
  salt: Buffer;
  hash: Buffer;
}

export function parsePasswordHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return null;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    return null;
  }
  const salt = Buffer.from(parts[3] as string, "base64url");
  const hash = Buffer.from(parts[4] as string, "base64url");
  if (salt.length < 8 || hash.length < 16) return null;
  return { iterations, salt, hash };
}

/** Constant-time check of `password` against a stored hash. False for a malformed hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (parsed === null) return false;
  const actual = await derive(
    password,
    parsed.salt,
    parsed.iterations,
    parsed.hash.length,
    "sha256",
  );
  return timingSafeEqual(actual, parsed.hash);
}
