import { afterEach, describe, expect, it } from "vitest";
import { groupHref, parseHash, route, startRouter } from "../src/router.ts";

afterEach(() => {
  location.hash = "";
});

describe("router", () => {
  it("parses every route", () => {
    expect(parseHash("")).toEqual({ name: "review" });
    expect(parseHash("#/review")).toEqual({ name: "review" });
    expect(parseHash("#/")).toEqual({ name: "review" });
    expect(parseHash("#/review/")).toEqual({ name: "review" });
    expect(parseHash("#/history")).toEqual({ name: "history", groupId: null });
    expect(parseHash("#/history/")).toEqual({ name: "history", groupId: null });
    expect(parseHash("#/history/a%20b")).toEqual({ name: "history", groupId: "a b" });
    expect(parseHash("#backfill")).toEqual({ name: "backfill" });
    expect(parseHash("#/settings")).toEqual({ name: "settings" });
    expect(parseHash("#/browser")).toEqual({ name: "browser" });
  });

  it("sends anything unknown to the not-found view, never the review queue", () => {
    expect(parseHash("#/nope")).toEqual({ name: "not_found", path: "nope" });
    expect(parseHash("#/review/x")).toEqual({ name: "not_found", path: "review/x" });
    expect(parseHash("#/settings/extra")).toEqual({ name: "not_found", path: "settings/extra" });
    expect(parseHash("#/history/a/b")).toEqual({ name: "not_found", path: "history/a/b" });
    expect(parseHash("#/history/%E0%A4%A")).toEqual({
      name: "not_found",
      path: "history/%E0%A4%A",
    });
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
