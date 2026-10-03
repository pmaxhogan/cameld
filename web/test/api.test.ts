import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiFailure,
  apiGet,
  apiPatch,
  apiPost,
  errorText,
  isFailure,
  onWrite,
} from "../src/api.ts";
import { stubApi } from "./helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client", () => {
  it("GETs JSON without the CSRF header", async () => {
    const { calls } = stubApi({ "GET /api/x": { body: { a: 1 } } });
    await expect(apiGet("/api/x")).resolves.toEqual({ a: 1 });
    expect(calls[0]!.headers["x-requested-with"]).toBeUndefined();
    expect(calls[0]!.body).toBeUndefined();
  });

  it("sends the CSRF header and JSON on writes and notifies write listeners", async () => {
    const { calls } = stubApi({
      "POST /api/y": { body: { ok: true } },
      "PATCH /api/z": { status: 204 },
    });
    const listener = vi.fn();
    const stop = onWrite(listener);
    await expect(apiPost("/api/y", { b: 2 })).resolves.toEqual({ ok: true });
    await expect(apiPatch("/api/z", { c: 3 })).resolves.toBeUndefined();
    await apiPost("/api/y");
    expect(calls[0]!.headers).toMatchObject({
      "x-requested-with": "cameld",
      "content-type": "application/json",
    });
    expect(calls[0]!.body).toEqual({ b: 2 });
    expect(calls[2]!.body).toEqual({});
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
    await apiPost("/api/y");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("redirects to /login on 401", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign });
    stubApi({ "GET /api/x": { status: 401, body: { error: "unauthorized" } } });
    await expect(apiGet("/api/x")).rejects.toBeInstanceOf(ApiFailure);
    expect(assign).toHaveBeenCalledWith("/login");
  });

  it("throws the server's error and detail", async () => {
    stubApi({
      "GET /api/a": { status: 409, body: { error: "confirm_required", detail: "type it" } },
      "GET /api/b": { status: 500, badJson: true },
      "GET /api/c": { status: 400, body: null },
    });
    const a = await apiGet("/api/a").catch((e: unknown) => e);
    expect(a).toBeInstanceOf(ApiFailure);
    expect((a as ApiFailure).status).toBe(409);
    expect((a as ApiFailure).detail).toBe("type it");
    expect(errorText(a)).toBe("confirm_required: type it");
    expect(isFailure(a, "confirm_required")).toBe(true);
    expect(isFailure(a, "other")).toBe(false);
    expect(isFailure(new Error("x"), "confirm_required")).toBe(false);
    expect(errorText(await apiGet("/api/b").catch((e: unknown) => e))).toBe("http_500");
    expect(errorText(await apiGet("/api/c").catch((e: unknown) => e))).toBe("http_400");
  });

  it("describes any thrown value", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
  });
});
