import { describe, expect, it } from "vitest";

import {
  classify,
  classifyUpload,
  isLoginPath,
  looksLikeChallenge,
  parseContentDisposition,
  uploadErrorCode,
} from "../src/web/classify.ts";
import { DeletionAuthorization, type DeletionEvidence } from "../src/web/deletion-authorization.ts";
import {
  ChallengeError,
  DeletionUnauthorizedError,
  LoginRequiredError,
  WebNotFoundError,
  WebNotReadyError,
  WebUnexpectedResponseError,
} from "../src/web/errors.ts";
import {
  buildSubmission,
  changedFields,
  describeChanges,
  FIELD,
  type FormEntries,
  lastValue,
  missingRequiredFields,
  photoIds,
  readValues,
  REDACTED,
  sameEntries,
  setEntry,
} from "../src/web/forms.ts";
import {
  assertSubmittable,
  deletionConfirmed,
  parseUploadTarget,
  uploadHeaders,
} from "../src/web/session.ts";

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

describe("classifyUpload", () => {
  const s3 = (code: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code>` +
    "<Message>synthetic</Message><Key>synthetic/key.jpg</Key></Error>";

  it("accepts any 2xx", () => {
    expect(classifyUpload(200, "")).toBeNull();
    expect(classifyUpload(204, s3("AccessDenied"))).toBeNull();
  });

  it("turns every other status into an unexpected response, never a login or challenge", () => {
    for (const status of [0, 301, 401, 403, 404, 429, 500]) {
      const error = classifyUpload(status, '<title>Just a moment</title><div class="g-recaptcha">');
      expect(error?.constructor).toBe(WebUnexpectedResponseError);
      expect(error?.message).toBe(`photo upload host returned ${status}`);
    }
  });

  it("names the S3 error code and nothing else of the body", () => {
    for (const code of ["SignatureDoesNotMatch", "AccessDenied", "RequestExpired"]) {
      expect(uploadErrorCode(s3(code))).toBe(code);
      expect(classifyUpload(403, s3(code))?.message).toBe(
        `photo upload host returned 403 (${code})`,
      );
    }
    expect(uploadErrorCode("<Error>\n  <Code> AccessDenied </Code>\n</Error>")).toBe(
      "AccessDenied",
    );
  });

  it("finds no code in anything that is not an S3 error", () => {
    expect(uploadErrorCode("")).toBeNull();
    expect(uploadErrorCode("bad signature")).toBeNull();
    expect(uploadErrorCode('{"Code":"AccessDenied"}')).toBeNull();
    expect(uploadErrorCode("<html><Code>AccessDenied</Code></html>")).toBeNull();
    expect(uploadErrorCode("<Error><Code>synthetic/key.jpg?sig=1</Code></Error>")).toBeNull();
    expect(uploadErrorCode(`<Error><Code>${"A".repeat(65)}</Code></Error>`)).toBeNull();
    expect(
      uploadErrorCode(`<Error>${" ".repeat(5000)}<Code>AccessDenied</Code></Error>`),
    ).toBeNull();
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

  it("reads hide_from_home as on for true, 1 and on, in any case", () => {
    const hidden = (value: string) =>
      readValues([
        [FIELD.hideFromHome, "false"],
        [FIELD.hideFromHome, value],
      ]).hideFromHome;
    for (const on of ["true", "TRUE", "True", "1", "on", "ON"]) expect(hidden(on)).toBe(true);
    for (const off of ["false", "0", "off", ""]) expect(hidden(off)).toBe(false);
    expect(readValues([]).hideFromHome).toBe(false);
  });

  it("lists required fields a form lacks", () => {
    const complete: FormEntries = [
      ["authenticity_token", "synthetic-token"],
      [FIELD.privateNote, ""],
      [FIELD.visibility, "only_me"],
    ];
    expect(missingRequiredFields(complete)).toEqual([]);
    expect(missingRequiredFields([])).toEqual([
      "authenticity_token",
      FIELD.visibility,
      FIELD.privateNote,
    ]);
    expect(
      missingRequiredFields([
        ["authenticity_token", ""],
        [FIELD.privateNote, "kept"],
        [FIELD.visibility, ""],
      ]),
    ).toEqual(["authenticity_token", FIELD.visibility]);
  });

  it("refuses to submit a form without its required fields", () => {
    const path = "/activities/7000001";
    expect(() =>
      assertSubmittable(path, [
        ["_method", "patch"],
        ["authenticity_token", "synthetic-token"],
        [FIELD.privateNote, "x"],
        [FIELD.visibility, "everyone"],
      ]),
    ).not.toThrow();
    const error = (() => {
      try {
        assertSubmittable(path, [
          ["authenticity_token", "synthetic-token"],
          [FIELD.privateNote, "x"],
        ]);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(WebNotReadyError);
    expect((error as WebNotReadyError).fields).toEqual([FIELD.visibility]);
    expect((error as WebNotReadyError).message).not.toContain("synthetic-token");
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

  it("compares snapshots entry by entry, in order", () => {
    expect(sameEntries(entries, [...entries])).toBe(true);
    expect(sameEntries([], [])).toBe(true);
    expect(sameEntries(entries, entries.slice(1))).toBe(false);
    expect(sameEntries([["a", "1"]], [["a", "2"]])).toBe(false);
    expect(sameEntries([["a", "1"]], [["b", "1"]])).toBe(false);
    expect(
      sameEntries(
        [
          ["a", "1"],
          ["b", "2"],
        ],
        [
          ["b", "2"],
          ["a", "1"],
        ],
      ),
    ).toBe(false);
  });

  it("describes changes, showing values of fixed-vocabulary fields only", () => {
    const before: FormEntries = [
      ["activity[name]", "Synthetic Name"],
      ["activity[selected_polyline_style]", "default"],
      ["activity[synthetic_hidden]", "synthetic words"],
      ["photos[p-1][rank]", "1"],
      ["photos[p-1][caption]", "synthetic caption"],
    ];
    const after: FormEntries = [
      ["activity[name]", "Other Synthetic Name"],
      ["activity[selected_polyline_style]", "pace"],
      ["photos[p-1][rank]", "2"],
      ["photos[p-1][caption]", ""],
      ["activity[flag]", "x".repeat(100)],
    ];
    const names = [...before, ...after].map(([name]) => name);
    expect(
      describeChanges(names, before, after, [
        "activity[selected_polyline_style]",
        "activity[flag]",
      ]),
    ).toEqual([
      { field: "activity[name]", before: REDACTED, after: REDACTED },
      { field: "activity[selected_polyline_style]", before: "default", after: "pace" },
      { field: "activity[synthetic_hidden]", before: REDACTED, after: null },
      { field: "photos[p-1][rank]", before: "1", after: "2" },
      { field: "photos[p-1][caption]", before: REDACTED, after: REDACTED },
      { field: "activity[flag]", before: null, after: "x".repeat(64) },
    ]);
    expect(REDACTED).toBe("<redacted>");
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

  it("accepts the live shape and only a PUT upload", () => {
    const live = {
      uri: "https://up.example.test/3?X-Synthetic-Signature=1",
      header: { "Content-Type": "image/jpeg", Host: "up.example.test" },
      max_size: 1000,
    };
    for (const method of ["PUT", "put"])
      expect(parseUploadTarget(json({ ...live, method }))).toEqual({
        uri: live.uri,
        header: live.header,
      });
    for (const method of ["POST", "", 1, null])
      expect(() => parseUploadTarget(json({ ...live, method }))).toThrow(
        "photo metadata answer has an unsupported upload method",
      );
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

describe("uploadHeaders", () => {
  it("sends the signed content type exactly once, whatever the file is", () => {
    expect(
      uploadHeaders("image/png", { "Content-Type": "image/jpeg", Host: "up.example.test" }),
    ).toEqual({ "content-type": "image/jpeg" });
    expect(uploadHeaders("image/png", { "CONTENT-TYPE": "image/jpeg", HOST: "x" })).toEqual({
      "content-type": "image/jpeg",
    });
  });

  it("keeps our content type when none is returned and lower-cases other headers", () => {
    expect(uploadHeaders("image/png", {})).toEqual({ "content-type": "image/png" });
    expect(uploadHeaders("image/png", { "X-Synthetic-Meta": "Kept As Is" })).toEqual({
      "content-type": "image/png",
      "x-synthetic-meta": "Kept As Is",
    });
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

  it("accepts the trial allowance only for a rollout trial deletion", () => {
    const trial = DeletionAuthorization.mint(
      { ...evidence, deletionSwitch: "trial", reason: "rollout_trial" },
      NOW,
    );
    expect(trial.reason).toBe("rollout_trial");
    expect(() => DeletionAuthorization.mint({ ...evidence, deletionSwitch: "trial" }, NOW)).toThrow(
      "cannot authorize deletion: deletionSwitch",
    );
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

describe("deletionConfirmed", () => {
  it("accepts 404 or a known post-delete page, nothing else", () => {
    expect(deletionConfirmed(404, "/activities/7000002")).toBe(true);
    expect(deletionConfirmed(200, "/athlete/training")).toBe(true);
    expect(deletionConfirmed(200, "/dashboard")).toBe(true);
    expect(deletionConfirmed(200, "/activities/7000002")).toBe(false);
    expect(deletionConfirmed(200, "/features")).toBe(false);
    expect(deletionConfirmed(500, "/dashboard")).toBe(false);
  });
});
