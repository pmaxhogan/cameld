import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";

/**
 * Write-once, checksummed file store for backups (ARCHITECTURE.md section 7).
 *
 * writeOnce(path, bytes):
 *   1. writes the bytes to a temp file in the same directory and fsyncs it,
 *   2. hard-links the temp file to the final path. link() fails atomically
 *      when the path exists, so this is a rename that can never replace an
 *      existing backup, even under a race,
 *   3. when the path already exists: identical bytes are a no-op, different
 *      bytes throw BackupConflictError and leave the existing file untouched,
 *   4. writes `<path>.sha256` in sha256sum format the same way (temp, fsync,
 *      rename), and fsyncs the directory so the new names are durable.
 *
 * verify(path) re-reads the file and checks it against the sidecar.
 */

export const SIDECAR_SUFFIX = ".sha256";

export class BackupConflictError extends Error {
  override readonly name = "BackupConflictError";
}

export class BackupIntegrityError extends Error {
  override readonly name = "BackupIntegrityError";
}

export interface WriteOnceResult {
  path: string;
  sha256: string;
  size: number;
  /** "written" for a new file, "unchanged" when identical bytes were already there. */
  status: "written" | "unchanged";
}

export type VerifyFailure = "missing-file" | "missing-sidecar" | "malformed-sidecar" | "mismatch";

export type VerifyResult =
  | { ok: true; path: string; sha256: string; size: number }
  | {
      ok: false;
      path: string;
      reason: VerifyFailure;
      expected: string | undefined;
      actual: string | undefined;
    };

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The sidecar line, exactly as `sha256sum` prints it, so `sha256sum -c` works on the host. */
export function sidecarLine(path: string, sha256: string): string {
  return `${sha256}  ${basename(path)}\n`;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Directory fsync makes a rename or link durable on Linux. Windows cannot
 * open a directory for sync (EISDIR / EPERM); there the call is skipped.
 */
export function isUnsupportedDirSync(code: string | undefined): boolean {
  return code === "EISDIR" || code === "EPERM";
}

export async function fsyncDirectory(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirSync(errorCode(error))) throw error;
  } finally {
    await handle?.close();
  }
}

const ignore = (): undefined => undefined;

/** Remove a temp file if it is still there. */
async function removeQuietly(path: string): Promise<void> {
  await unlink(path).catch(ignore);
}

function tempPathFor(path: string): string {
  return `${dirname(path)}/.${basename(path)}.tmp-${randomBytes(6).toString("hex")}`;
}

async function writeSynced(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function writeSidecar(path: string, sha256: string): Promise<void> {
  const sidecarPath = `${path}${SIDECAR_SUFFIX}`;
  const expected = sidecarLine(path, sha256);
  const existing = await readOptional(sidecarPath);
  if (existing !== undefined) {
    if (existing.toString("utf8") !== expected) {
      throw new BackupIntegrityError(
        `${sidecarPath} disagrees with the stored file; refusing to rewrite it`,
      );
    }
    return;
  }
  const temp = tempPathFor(sidecarPath);
  try {
    await writeSynced(temp, Buffer.from(expected, "utf8"));
    await rename(temp, sidecarPath);
  } finally {
    await removeQuietly(temp);
  }
}

/** Write bytes to path exactly once. See the module comment for the protocol. */
export async function writeOnce(path: string, bytes: Uint8Array): Promise<WriteOnceResult> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const sha256 = sha256Hex(bytes);
  const temp = tempPathFor(path);
  let status: WriteOnceResult["status"] = "written";
  try {
    await writeSynced(temp, bytes);
    try {
      await link(temp, path);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const existing = await readFile(path);
      if (sha256Hex(existing) !== sha256) {
        throw new BackupConflictError(`${path} already exists with different content`);
      }
      status = "unchanged";
    }
  } finally {
    await removeQuietly(temp);
  }
  await writeSidecar(path, sha256);
  await fsyncDirectory(dir);
  return { path, sha256, size: bytes.byteLength, status };
}

/** Re-read path and check it against its sha256 sidecar. Never throws for a bad backup. */
export async function verify(path: string): Promise<VerifyResult> {
  const fail = (reason: VerifyFailure, expected?: string, actual?: string): VerifyResult => ({
    ok: false,
    path,
    reason,
    expected,
    actual,
  });
  const bytes = await readOptional(path);
  if (bytes === undefined) return fail("missing-file");
  const actual = sha256Hex(bytes);
  const sidecar = await readOptional(`${path}${SIDECAR_SUFFIX}`);
  if (sidecar === undefined) return fail("missing-sidecar", undefined, actual);
  const match = /^([0-9a-f]{64}) [ *](.+)\n?$/.exec(sidecar.toString("utf8"));
  if (match === null || match[2] !== basename(path)) {
    return fail("malformed-sidecar", undefined, actual);
  }
  const expected = match[1]!;
  if (expected !== actual) return fail("mismatch", expected, actual);
  return { ok: true, path, sha256: actual, size: bytes.byteLength };
}
