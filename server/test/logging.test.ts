import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createBootLogger, createLogger } from "../src/logging.ts";

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("createLogger", () => {
  it("emits NDJSON with the service name and ISO time", () => {
    const sink = capture();
    createLogger({ logLevel: "info" }, sink.stream).info({ a: 1 }, "hello");
    const [line] = sink.lines();
    expect(line).toMatchObject({ name: "cameld", msg: "hello", a: 1 });
    expect(typeof line?.time).toBe("string");
  });

  it("redacts auth headers, cookies, and secret-like fields", () => {
    const sink = capture();
    const log = createLogger({ logLevel: "info" }, sink.stream);
    log.info(
      {
        req: { headers: { authorization: "Bearer abc", cookie: "sid=1", "x-ok": "visible" } },
        password: "pw-top",
        token: "tok-top",
        secret: "sec-top",
        nested: { password: "pw-in", token: "tok-in", secret: "sec-in", keep: "kept" },
      },
      "redaction",
    );
    const text = JSON.stringify(sink.lines());
    for (const leaked of [
      "Bearer abc",
      "sid=1",
      "pw-top",
      "tok-top",
      "sec-top",
      "pw-in",
      "tok-in",
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).not.toContain("sec-in");
    expect(text).toContain("[redacted]");
    expect(text).toContain("visible");
    expect(text).toContain("kept");
  });

  it("respects the configured level", () => {
    const sink = capture();
    createLogger({ logLevel: "warn" }, sink.stream).info("dropped");
    expect(sink.lines()).toHaveLength(0);
  });

  it("builds a boot logger", () => {
    expect(createBootLogger("silent").level).toBe("silent");
  });
});
