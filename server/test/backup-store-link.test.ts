import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A filesystem that cannot hard link (EPERM) must fail loudly, not fall back to
// an overwriting rename, and must not leave its temp file behind.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(async () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    }),
  };
});

const { writeOnce } = await import("../src/backup-store.ts");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cameld-backup-link-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("propagates a link failure other than EEXIST and cleans up", async () => {
  await expect(writeOnce(join(dir, "a.bin"), new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
    code: "EPERM",
  });
  expect(await readdir(dir)).toEqual([]);
});
