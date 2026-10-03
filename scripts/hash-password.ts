// Generate the backup password and its UI_PASSWORD_HASH (pbkdf2$sha256$...).
//
//   node scripts/hash-password.ts                 generates a random password
//   node scripts/hash-password.ts < password.txt  hashes the password on stdin
//
// The password is never taken from argv (it would land in shell history and
// the process list). A generated password is printed once; store it in a
// password manager and put only the hash in the host's .env.
import { randomBytes } from "node:crypto";
import { hashPassword } from "../server/src/auth/password.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const LENGTH = 24;

function generatePassword(): string {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = "";
  while (out.length < LENGTH) {
    for (const byte of randomBytes(LENGTH)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === LENGTH) break;
    }
  }
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

const piped = !process.stdin.isTTY;
const supplied = piped ? await readStdin() : "";
const password = supplied === "" ? generatePassword() : supplied;
const hash = await hashPassword(password);
if (supplied === "") process.stdout.write(`password: ${password}\n`);
process.stdout.write(`UI_PASSWORD_HASH=${hash}\n`);
