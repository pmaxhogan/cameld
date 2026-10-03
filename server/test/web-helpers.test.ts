import { describe, expect, it } from "vitest";

import {
  classify,
  isLoginPath,
  looksLikeChallenge,
  parseContentDisposition,
} from "../src/web/classify.ts";
import { DeletionAuthorization, type DeletionEvidence } from "../src/web/deletion-authorization.ts";
import {
  ChallengeError,
  DeletionUnauthorizedError,
  LoginRequiredError,
  WebNotFoundError,
  WebUnexpectedResponseError,
} from "../src/web/errors.ts";
import {
  buildSubmission,
  changedFields,
  FIELD,
  type FormEntries,
  lastValue,
  photoIds,
  readValues,
  setEntry,
} from "../src/web/forms.ts";
import { parseUploadTarget } from "../src/web/session.ts";

const BASE = "https://www.example.test";

describe("classify", () => {
  const ok = { status: 200, url: `${BASE}/dashboard`, html: "<html></html>" };

  it("accepts a normal answer", () => {
    expect(classify(ok, { path: "/dashboard" })).toBeNull();
  });

  it("detects login redirects and 401", () => {
    for (const path of ["/login", "/login/otp", "/session/new", "/register"]) {
      expect(isLoginPath(path)).toBe(true);
      expect(classify({ ...ok, url: `${BASE}${path}` }, { path: "/x" })).toBeInstanceOf(
        LoginRequiredError,
      );
    }
    expect(isLoginPath("/logins-are-fine")).toBe(false);
    expect(classify({ ...ok, status: 401 }, { path: "/x" })).toBeInstanceOf(LoginRequiredError);
  });

  it("detects challenges, 403 and 429", () => {
    const kind = (status: number, html = "") =>
      (classify({ ...ok, status, html }, { path: "/x" }) as ChallengeError).kind;
    expect(kind(429)).toBe("rate_limited");
    expect(kind(403)).toBe("forbidden");
    expect(kind(200, "<title>Just a moment...</title>")).toBe("captcha");
    expect(kind(403, '<div class="g-recaptcha">')).toBe("captcha");
  });

  it("knows challenge markers but not the invisible login reCAPTCHA script", () => {
    expect(looksLikeChallenge('<iframe src="https://x/recaptcha/enterprise/bframe">')).toBe(true);
    expect(looksLikeChallenge('<script src="/cdn-cgi/challenge-platform/x.js">')).toBe(true);
    expect(looksLikeChallenge('<form id="cf-chl-widget">')).toBe(true);
    expect(looksLikeChallenge("<p>Please verify that you are a human</p>")).toBe(true);
    expect(looksLikeChallenge('<script src="https://x/recaptcha/enterprise.js?render=k">')).toBe(
      false,
    );
  });

  it("maps 404 and other failures", () => {
    expect(classify({ ...ok, status: 404 }, { path: "/a" })).toBeInstanceOf(WebNotFoundError);
    expect(classify({ ...ok, status: 404 }, { path: "/a", allowNotFound: true })).toBeNull();
    const error = classify({ ...ok, status: 500 }, { path: "/a" });
    expect(error).toBeInstanceOf(WebUnexpectedResponseError);
    expect(error?.message).toBe("strava.com returned 500 for /a");
    expect(classify({ ...ok, status: 0 }, { path: "/a" })).toBeInstanceOf(
      WebUnexpectedResponseError,
    );
  });
});

describe("parseContentDisposition", () => {
  it("reads the plain, quoted and extended forms", () => {
    expect(parseContentDisposition(undefined)).toBeNull();
    expect(parseContentDisposition("attachment")).toBeNull();
    expect(parseContentDisposition("attachment; filename=run.fit")).toBe("run.fit");
    expect(parseContentDisposition('attachment; filename="a \\"b\\".gpx"')).toBe('a "b".gpx');
    expect(
      parseContentDisposition(`attachment; filename="x.fit"; filename*=UTF-8''caf%C3%A9.fit`),
    ).toBe("café.fit");
  });

  it("falls back from malformed encoding and strips directories", () => {
    expect(
      parseContentDisposition(`attachment; filename*=UTF-8''bad%E0%A4; filename="ok.tcx"`),
    ).toBe("ok.tcx");
    expect(parseContentDisposition('attachment; filename="../../etc/passwd"')).toBe("passwd");
    expect(parseContentDisposition('attachment; filename="dir\\\\run.gpx"')).toBe("run.gpx");
    expect(parseContentDisposition('attachment; filename=".."')).toBeNull();
    expect(parseContentDisposition('attachment; filename="sub/"')).toBeNull();
  });
});

describe("form entries", () => {
  const entries: FormEntries = [
    ["_method", "patch"],
    ["authenticity_token", "synthetic-token"],
    [FIELD.privateNote, "line 1\r\nline 2"],
    [FIELD.visibility, "followers_only"],
    [FIELD.perceivedExertion, "6"],
    [FIELD.preferPerceivedExertion, "0"],
    [FIELD.preferPerceivedExertion, "1"],
    [FIELD.hideFromHome, "0"],
    ["photos[p-1][rank]", "1"],
    ["photos[p-1][caption]", ""],
    ["photos[p-2][rank]", "2"],
  ];

  it("reads values with Rails last-wins semantics", () => {
    expect(lastValue(entries, FIELD.preferPerceivedExertion)).toBe("1");
    expect(lastValue(entries, "missing")).toBeNull();
    expect(readValues(entries)).toEqual({
      privateNote: "line 1\nline 2",
      visibility: "followers_only",
      perceivedExertion: 6,
      preferPerceivedExertion: true,
      hideFromHome: false,
    });
    expect(readValues([[FIELD.visibility, "galaxy"]])).toEqual({
      privateNote: "",
      visibility: null,
      perceivedExertion: null,
      preferPerceivedExertion: false,
      hideFromHome: false,
    });
  });

  it("replaces every occurrence in place, or appends", () => {
    const set = setEntry(entries, FIELD.preferPerceivedExertion, "0");
    expect(set.filter(([n]) => n === FIELD.preferPerceivedExertion)).toEqual([
      [FIELD.preferPerceivedExertion, "0"],
    ]);
    expect(set.indexOf(set.find(([n]) => n === FIELD.preferPerceivedExertion)!)).toBe(5);
    expect(setEntry([], "a", "b")).toEqual([["a", "b"]]);
  });

  it("builds a submission that keeps everything but the change", () => {
    const body = buildSubmission(entries, "fresh-token", "patch", [[FIELD.visibility, "only_me"]]);
    expect(body.slice(0, 2)).toEqual([
      ["_method", "patch"],
      ["authenticity_token", "fresh-token"],
    ]);
    expect(body).toHaveLength(entries.length);
    expect(changedFields(entries, body)).toEqual([FIELD.visibility]);
    expect(buildSubmission(entries, "t", "delete").slice(0, 1)).toEqual([["_method", "delete"]]);
  });

  it("lists changed and appearing or vanishing fields", () => {
    expect(changedFields(entries, entries)).toEqual([]);
    expect(changedFields([["a", "x\r\ny"]], [["a", "x\ny"]])).toEqual([]);
    expect(changedFields([["a", "1"]], [["b", "1"]])).toEqual(["a", "b"]);
  });

  it("finds photo ids", () => {
    expect(photoIds(entries)).toEqual(["p-1", "p-2"]);
    expect(photoIds([["activity[name]", "x"]])).toEqual([]);
  });
});

describe("parseUploadTarget", () => {
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));

  it("accepts a uri with string headers, or none", () => {
    expect(
      parseUploadTarget(json({ uri: "https://up.example.test/1", header: { a: "b" } })),
    ).toEqual({ uri: "https://up.example.test/1", header: { a: "b" } });
    expect(parseUploadTarget(json({ uri: "https://up.example.test/2" })).header).toEqual({});
  });

  it("rejects anything else", () => {
    for (const body of [
      Buffer.from("not json"),
      json(null),
      json({ header: {} }),
      json({ uri: "u", header: null }),
      json({ uri: "u", header: "x" }),
      json({ uri: "u", header: { a: 1 } }),
    ]) {
      expect(() => parseUploadTarget(body)).toThrow(WebUnexpectedResponseError);
    }
  });
});

describe("DeletionAuthorization", () => {
  const NOW = Date.parse("2030-04-03T12:00:00Z");
  const evidence: DeletionEvidence = {
    activityId: 7000002,
    deletionSwitch: "on",
    originalFileBackedUp: true,
    backupVerifiedAt: NOW - 60_000,
    snapshot: "pool/cameld@synthetic",
    reason: "path_a_grace_elapsed",
  };

  it("mints a single-use token for one activity", () => {
    const auth = DeletionAuthorization.mint(evidence, NOW);
    expect(auth).toMatchObject({
      activityId: 7000002,
      reason: "path_a_grace_elapsed",
      snapshot: "pool/cameld@synthetic",
      mintedAt: NOW,
      expiresAt: NOW + DeletionAuthorization.TTL_MS,
      consumed: false,
    });
    expect(() => DeletionAuthorization.consume(auth, 7000001, NOW)).toThrow(/not 7000001/);
    DeletionAuthorization.consume(auth, 7000002, NOW);
    expect(auth.consumed).toBe(true);
    expect(() => DeletionAuthorization.consume(auth, 7000002, NOW)).toThrow(/already used/);
  });

  it("expires", () => {
    const auth = DeletionAuthorization.mint(evidence, NOW);
    expect(() =>
      DeletionAuthorization.consume(auth, 7000002, NOW + DeletionAuthorization.TTL_MS + 1),
    ).toThrow(/expired/);
  });

  it("defaults the clock to now", () => {
    const auth = DeletionAuthorization.mint({ ...evidence, backupVerifiedAt: Date.now() - 1 });
    DeletionAuthorization.consume(auth, 7000002);
    expect(auth.consumed).toBe(true);
  });

  it("refuses incomplete evidence, naming every gap", () => {
    const bad = {
      activityId: 0,
      deletionSwitch: "off",
      originalFileBackedUp: false,
      backupVerifiedAt: NOW + 1,
      snapshot: " ",
      reason: "because",
    } as unknown as DeletionEvidence;
    expect(() => DeletionAuthorization.mint(bad, NOW)).toThrow(
      "cannot authorize deletion: activityId, deletionSwitch, originalFileBackedUp, snapshot, reason, backupVerifiedAt",
    );
    expect(() =>
      DeletionAuthorization.mint(
        { ...evidence, backupVerifiedAt: NOW - DeletionAuthorization.TTL_MS - 1 },
        NOW,
      ),
    ).toThrow(/backupVerifiedAt/);
    expect(() =>
      DeletionAuthorization.mint(
        { ...evidence, snapshot: undefined as unknown as string, backupVerifiedAt: Number.NaN },
        NOW,
      ),
    ).toThrow(DeletionUnauthorizedError);
  });

  it("refuses look-alikes", () => {
    for (const fake of [null, undefined, 7000002, { activityId: 7000002, consumed: false }]) {
      expect(() => DeletionAuthorization.consume(fake, 7000002, NOW)).toThrow(
        "not a DeletionAuthorization",
      );
    }
  });
});
