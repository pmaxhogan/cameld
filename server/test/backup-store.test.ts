import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BackupConflictError,
  BackupIntegrityError,
  SIDECAR_SUFFIX,
  fsyncDirectory,
  isUnsupportedDirSync,
  sha256Hex,
  sidecarLine,
  verify,
  writeOnce,
} from "../src/backup-store.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cameld-backup-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Everything in the directory that is neither the file nor its sidecar. */
async function leftovers(inDir: string, name: string): Promise<string[]> {
  const entries = await readdir(inDir);
  return entries.filter((entry) => entry !== name && entry !== `${name}${SIDECAR_SUFFIX}`);
}

describe("writeOnce", () => {
  it("writes the file and a sha256sum-format sidecar, creating parent directories", async () => {
    const path = join(dir, "activities", "a1", "original.fit");
    const content = bytes("synthetic payload");
    const result = await writeOnce(path, content);

    const sha256 = sha256Hex(content);
    expect(result).toEqual({ path, sha256, size: content.byteLength, status: "written" });
    expect(await readFile(path)).toEqual(Buffer.from(content));
    expect(await readFile(`${path}${SIDECAR_SUFFIX}`, "utf8")).toBe(`${sha256}  original.fit\n`);
    expect(await leftovers(join(dir, "activities", "a1"), "original.fit")).toEqual([]);
    expect(await verify(path)).toEqual({ ok: true, path, sha256, size: content.byteLength });
  });

  it("is idempotent for identical bytes", async () => {
    const path = join(dir, "same.bin");
    await writeOnce(path, bytes("abc"));
    const again = await writeOnce(path, bytes("abc"));
    expect(again.status).toBe("unchanged");
    expect(await leftovers(dir, "same.bin")).toEqual([]);
  });

  it("restores a missing sidecar when the bytes already match", async () => {
    const path = join(dir, "orphan.bin");
    await writeFile(path, "abc");
    const result = await writeOnce(path, bytes("abc"));
    expect(result.status).toBe("unchanged");
    expect((await verify(path)).ok).toBe(true);
  });

  it("refuses different bytes and leaves the original and its sidecar untouched", async () => {
    const path = join(dir, "keep.bin");
    await writeOnce(path, bytes("first"));
    const sidecarBefore = await readFile(`${path}${SIDECAR_SUFFIX}`, "utf8");

    await expect(writeOnce(path, bytes("second"))).rejects.toThrow(BackupConflictError);
    expect(await readFile(path, "utf8")).toBe("first");
    expect(await readFile(`${path}${SIDECAR_SUFFIX}`, "utf8")).toBe(sidecarBefore);
    expect(await leftovers(dir, "keep.bin")).toEqual([]);
  });

  it("refuses to rewrite a sidecar that disagrees with the stored file", async () => {
    const path = join(dir, "tampered.bin");
    await writeFile(path, "abc");
    await writeFile(`${path}${SIDECAR_SUFFIX}`, sidecarLine(path, "0".repeat(64)));
    await expect(writeOnce(path, bytes("abc"))).rejects.toThrow(BackupIntegrityError);
  });

  it("cleans up its temp file when the target cannot be linked", async () => {
    const path = join(dir, "occupied");
    await mkdir(path);
    await expect(writeOnce(path, bytes("abc"))).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["occupied"]);
  });
});

describe("verify", () => {
  it("reports a corrupted file as a mismatch with both hashes", async () => {
    const path = join(dir, "rot.bin");
    const written = await writeOnce(path, bytes("original"));
    await rm(path);
    await writeFile(path, "bitrot!!");
    expect(await verify(path)).toEqual({
      ok: false,
      path,
      reason: "mismatch",
      expected: written.sha256,
      actual: sha256Hex(bytes("bitrot!!")),
    });
  });

  it("reports a missing file and a missing sidecar", async () => {
    const path = join(dir, "nothing.bin");
    expect(await verify(path)).toMatchObject({ ok: false, reason: "missing-file" });
    await writeFile(path, "x");
    expect(await verify(path)).toMatchObject({
      ok: false,
      reason: "missing-sidecar",
      actual: sha256Hex(bytes("x")),
    });
  });

  it("reports a malformed sidecar or one naming another file", async () => {
    const path = join(dir, "odd.bin");
    await writeFile(path, "x");
    await writeFile(`${path}${SIDECAR_SUFFIX}`, "not a checksum\n");
    expect(await verify(path)).toMatchObject({ ok: false, reason: "malformed-sidecar" });
    await writeFile(`${path}${SIDECAR_SUFFIX}`, `${sha256Hex(bytes("x"))}  other.bin\n`);
    expect(await verify(path)).toMatchObject({ ok: false, reason: "malformed-sidecar" });
  });

  it("accepts the binary-mode marker sha256sum -b writes", async () => {
    const path = join(dir, "bin.bin");
    await writeFile(path, "x");
    await writeFile(`${path}${SIDECAR_SUFFIX}`, `${sha256Hex(bytes("x"))} *bin.bin\n`);
    expect((await verify(path)).ok).toBe(true);
  });

  it("throws for I/O errors that are not a missing file", async () => {
    await expect(verify(dir)).rejects.toThrow();
  });
});

describe("fsyncDirectory", () => {
  it("syncs an existing directory (or skips where the platform cannot)", async () => {
    await expect(fsyncDirectory(dir)).resolves.toBeUndefined();
  });

  it("rethrows real errors such as a missing directory", async () => {
    await expect(fsyncDirectory(join(dir, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("only treats the platform's unsupported codes as skippable", () => {
    expect(isUnsupportedDirSync("EISDIR")).toBe(true);
    expect(isUnsupportedDirSync("EPERM")).toBe(true);
    expect(isUnsupportedDirSync("ENOENT")).toBe(false);
    expect(isUnsupportedDirSync(undefined)).toBe(false);
  });
});
