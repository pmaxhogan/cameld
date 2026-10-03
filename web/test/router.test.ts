import { afterEach, describe, expect, it } from "vitest";
import { groupHref, parseHash, route, startRouter } from "../src/router.ts";

afterEach(() => {
  location.hash = "";
});

describe("router", () => {
  it("parses every route", () => {
    expect(parseHash("")).toEqual({ name: "review" });
    expect(parseHash("#/review")).toEqual({ name: "review" });
    expect(parseHash("#/nope")).toEqual({ name: "review" });
    expect(parseHash("#/history")).toEqual({ name: "history", groupId: null });
    expect(parseHash("#/history/a%20b")).toEqual({ name: "history", groupId: "a b" });
    expect(parseHash("#backfill")).toEqual({ name: "backfill" });
    expect(parseHash("#/settings")).toEqual({ name: "settings" });
    expect(parseHash("#/browser")).toEqual({ name: "browser" });
  });

  it("builds group links", () => {
    expect(groupHref("a b")).toBe("#/history/a%20b");
  });

  it("follows hashchange until stopped", () => {
    const stop = startRouter();
    location.hash = "#/settings";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(route.value).toEqual({ name: "settings" });
    stop();
    location.hash = "#/backfill";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(route.value).toEqual({ name: "settings" });
  });
});
