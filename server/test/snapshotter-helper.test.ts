import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpSnapshotter, SnapshotError } from "../src/service/snapshotter.ts";

/**
 * A stand-in for deploy/snapshot-helper/: a real HTTP server on loopback that
 * checks the bearer token the way the helper does. Everything here is
 * synthetic (dataset name, token).
 */
const DATASET = "pool/apps/example";
const TOKEN = "test-key";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

let server: Server | undefined;

async function startHelper(
  answer: (seen: Seen) => { status: number; body: string },
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(entry);
      const { status, body } = answer(entry);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

function helperLike(entry: Seen): { status: number; body: string } {
  if (entry.headers.authorization !== `Bearer ${TOKEN}`) {
    return { status: 401, body: '{"error": "unauthorized"}' };
  }
  const { label } = JSON.parse(entry.body) as { label: string };
  return {
    status: 200,
    body: JSON.stringify({ snapshot: `${DATASET}@cameld-${label}-20300101T000000Z` }),
  };
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("HttpSnapshotter against a helper over real HTTP", () => {
  it("sends the bearer token and returns the helper's snapshot name", async () => {
    const helper = await startHelper(helperLike);
    const snap = new HttpSnapshotter({ url: `${helper.url}/`, token: TOKEN });
    expect(await snap.snapshot("pre-delete-7")).toBe(
      `${DATASET}@cameld-pre-delete-7-20300101T000000Z`,
    );
    expect(helper.seen).toHaveLength(1);
    expect(helper.seen[0]).toMatchObject({ method: "POST", url: "/snapshot" });
    expect(helper.seen[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(helper.seen[0]?.body ?? "")).toEqual({ label: "pre-delete-7" });
  });

  it("fails closed when the helper rejects a missing or wrong token", async () => {
    const helper = await startHelper(helperLike);
    const without = new HttpSnapshotter({ url: helper.url });
    await expect(without.snapshot("pre-delete-1")).rejects.toThrow(SnapshotError);
    expect(helper.seen[0]?.headers.authorization).toBeUndefined();

    const wrong = new HttpSnapshotter({ url: helper.url, token: "not-the-key" });
    await expect(wrong.snapshot("pre-delete-1")).rejects.toThrow("snapshot helper answered 401");
  });

  it("never contacts the helper for a label it would reject", async () => {
    const helper = await startHelper(helperLike);
    const snap = new HttpSnapshotter({ url: helper.url, token: TOKEN });
    await expect(snap.snapshot("../x@y")).rejects.toThrow(SnapshotError);
    expect(helper.seen).toHaveLength(0);
  });

  it("rejects a 200 whose body is not a single dataset@name", async () => {
    const helper = await startHelper(() => ({ status: 200, body: '{"snapshot": "a@b@c"}' }));
    const snap = new HttpSnapshotter({ url: helper.url, token: TOKEN });
    await expect(snap.snapshot("pre-delete-2")).rejects.toThrow(
      "snapshot helper did not return a snapshot name",
    );
  });
});
