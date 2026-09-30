import { describe, expect, it } from "vitest";
import { parseHealth } from "../src/health.ts";

describe("parseHealth", () => {
  it("accepts a well-formed body", () => {
    expect(parseHealth({ ok: true, version: "1.2.3" })).toEqual({ ok: true, version: "1.2.3" });
  });

  it("rejects ok:false, a missing or empty version, and non-objects", () => {
    expect(parseHealth({ ok: false, version: "1.2.3" })).toBeNull();
    expect(parseHealth({ ok: true })).toBeNull();
    expect(parseHealth({ ok: true, version: "" })).toBeNull();
    expect(parseHealth(null)).toBeNull();
    expect(parseHealth("ok")).toBeNull();
  });
});
