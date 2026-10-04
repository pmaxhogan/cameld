import { Writable } from "node:stream";
import { type Browser, chromium } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "../src/logging.ts";
import { type RelayClient, RelayTimeoutError } from "../src/relay/client.ts";
import { DeletionAuthorization } from "../src/web/deletion-authorization.ts";
import {
  BrowserUnavailableError,
  ChallengeError,
  DeletionNotConfirmedError,
  DeletionUnauthorizedError,
  LoginRequiredError,
  WebNoFileError,
  WebNotFoundError,
  WebNotReadyError,
  WebTimeoutError,
  WebUnexpectedResponseError,
  WebVerificationError,
} from "../src/web/errors.ts";
import { WebSession, type WebSessionOptions } from "../src/web/session.ts";
import { type CdpChromium, launchCdpChromium, settleWithin } from "./fake-strava/chromium.ts";
import {
  RIDE_ID,
  RUN_ID,
  SYNTHETIC_ATHLETE_ID,
  SYNTHETIC_EMAIL,
  SYNTHETIC_FIT_HEADER,
  SYNTHETIC_PNG,
  syntheticActivities,
} from "./fake-strava/fixtures.ts";
import { type FakeStrava, startFakeStrava } from "./fake-strava/server.ts";

/**
 * WebSession against a real Chromium (spawned with CDP, like the sidecar)
 * and the fake strava.com server. All data is synthetic.
 */

let chrome: CdpChromium;
let fake: FakeStrava;
let observer: Browser;
const sessions: WebSession[] = [];
const logLines: string[] = [];

const logger = createLogger(
  { logLevel: "debug" },
  new Writable({
    write(chunk: Buffer, _enc, done) {
      logLines.push(chunk.toString());
      done();
    },
  }),
);

function open(extra: Partial<WebSessionOptions> = {}): WebSession {
  const session = new WebSession({
    cdpUrl: chrome.cdpUrl,
    baseUrl: fake.baseUrl,
    logger,
    navigationTimeoutMs: 5000,
    operationTimeoutMs: 15_000,
    ...extra,
  });
  sessions.push(session);
  return session;
}

function context() {
  const ctx = observer.contexts()[0];
  if (ctx === undefined) throw new Error("no default context");
  return ctx;
}

async function logIn(): Promise<void> {
  const page = await context().newPage();
  await page.goto(fake.sessionUrl);
  await page.close();
}

function authorize(activityId: number): DeletionAuthorization {
  return DeletionAuthorization.mint({
    activityId,
    deletionSwitch: "on",
    originalFileBackedUp: true,
    backupVerifiedAt: Date.now() - 1000,
    snapshot: "pool/cameld@synthetic-pre-delete",
    reason: "rollout_trial",
  });
}

function relayFor(server: FakeStrava, mode: "ok" | "timeout" | "broken" = "ok"): RelayClient {
  return {
    async waitForCode({ since, timeoutMs }) {
      if (mode === "timeout") throw new RelayTimeoutError(`no code within ${timeoutMs} ms`);
      if (mode === "broken") throw new Error("synthetic relay bug");
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const mail = server.mailbox.find((m) => m.at >= since);
        if (mail !== undefined) return { code: mail.code, receivedAt: mail.at };
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new RelayTimeoutError("no code");
    },
    getForwardingConfirmation: () => Promise.resolve(null),
  };
}

beforeAll(async () => {
  chrome = await launchCdpChromium();
  fake = await startFakeStrava();
  observer = await chromium.connectOverCDP(chrome.cdpUrl);
}, 120_000);

afterAll(async () => {
  await settleWithin(observer?.close());
  await settleWithin(fake?.close());
  await chrome?.close();
}, 120_000);

beforeEach(async () => {
  fake.mode = "normal";
  fake.hydrateMs = 1500;
  fake.acceptCodes = true;
  fake.activities = new Map(syntheticActivities().map((a) => [a.id, a]));
  fake.mailbox.length = 0;
  await logIn();
  fake.requests.length = 0;
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.disconnect();
  // The invariant every test shares: cameld never logs out.
  expect(fake.requests.filter((r) => r.path === "/session")).toEqual([]);
});

describe("health and keep-alive", () => {
  it("reports a live session and closes only its own page", async () => {
    const before = context().pages().length;
    const health = await open().health();
    expect(health).toMatchObject({ loggedIn: true, reason: null });
    await expect.poll(() => context().pages().length).toBe(before);
  });

  it("reports an expired session, a missing menu, a challenge and a server error", async () => {
    const session = open();
    fake.mode = "no_menu";
    expect((await session.health()).reason).toBe("athlete_menu_missing");
    fake.mode = "captcha";
    expect((await session.health()).reason).toBe("challenge");
    fake.mode = "server_error";
    expect((await session.health()).reason).toBe("unexpected_response");
    fake.mode = "normal";
    fake.expireSessions();
    expect(await session.health()).toMatchObject({ loggedIn: false, reason: "login_required" });
  });

  it("keepAlive logs healthy and unhealthy sessions", async () => {
    const session = open();
    expect((await session.keepAlive()).loggedIn).toBe(true);
    fake.expireSessions();
    expect((await session.keepAlive()).loggedIn).toBe(false);
    expect(logLines.some((l) => l.includes("strava web session unhealthy"))).toBe(true);
  });

  it("reports an unreachable browser without throwing", async () => {
    const session = open({ cdpUrl: "http://127.0.0.1:9", navigationTimeoutMs: 2000 });
    expect((await session.health()).reason).toBe("browser_unavailable");
    await expect(session.getEditForm(RUN_ID)).rejects.toBeInstanceOf(BrowserUnavailableError);
  });
});

describe("export", () => {
  it("downloads the original file byte for byte with its filename", async () => {
    const session = open();
    const run = await session.exportOriginal(RUN_ID);
    expect(run.filename).toBe("quillmere-canal-run.gpx");
    expect(run.contentType).toBe("application/octet-stream");
    expect(run.bytes.equals(fake.activities.get(RUN_ID)?.original.bytes as Buffer)).toBe(true);
    const ride = await session.exportOriginal(RIDE_ID);
    expect(ride.bytes.equals(SYNTHETIC_FIT_HEADER)).toBe(true);
  });

  it("exports GPX and names it when Strava gives no filename", async () => {
    const gpx = await open().exportGpx(RIDE_ID);
    expect(gpx.filename).toBe(`${RIDE_ID}.gpx`);
    expect(gpx.contentType).toContain("gpx");
    expect(gpx.bytes.toString("utf8")).toContain("<gpx");
  });

  it("refuses an HTML answer and reports a missing activity", async () => {
    const session = open();
    fake.mode = "export_html";
    const error = await session.exportOriginal(RUN_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebUnexpectedResponseError);
    expect(error).toBeInstanceOf(WebNoFileError);
    expect((error as WebNoFileError).response).toMatchObject({
      status: 200,
      finalPath: `/activities/${RUN_ID}/export_original`,
      redirected: false,
    });
    expect((error as WebNoFileError).response.contentType).toMatch(/^text\/html/);
    expect((error as WebNoFileError).response.size).toBeGreaterThan(0);
    expect((error as Error).message).toMatch(/did not return a file \(200 text\/html/);
    fake.mode = "normal";
    await expect(session.exportOriginal(1234)).rejects.toBeInstanceOf(WebNotFoundError);
  });
});

describe("edit form", () => {
  it("reads the CSRF token and current values", async () => {
    const form = await open().getEditForm(RUN_ID);
    expect(form.csrfToken).toBe(form.authenticityToken);
    expect(form.csrfToken.length).toBeGreaterThan(10);
    expect(form.values).toEqual({
      privateNote: "synthetic note",
      visibility: "everyone",
      perceivedExertion: 4,
      preferPerceivedExertion: true,
      hideFromHome: true,
    });
    expect(form.entries).toContainEqual(["photos[synthetic-photo-0001][caption]", "Synthetic"]);
    expect(form.entries.some(([name]) => name === "activity[photo_file]")).toBe(false);
  });

  it("changes visibility and preserves every other field", async () => {
    const values = await open().setVisibility(RUN_ID, "only_me");
    expect(values.visibility).toBe("only_me");
    const stored = fake.activities.get(RUN_ID);
    expect(stored).toMatchObject({
      visibility: "only_me",
      name: "Quillmere Canal Run",
      description: "Synthetic test activity.\nSecond line.",
      privateNote: "synthetic note",
      perceivedExertion: "4",
      preferPerceivedExertion: true,
      hideFromHome: true,
      commute: false,
    });
    expect(stored?.photos).toHaveLength(1);
    const post = fake.requests.find((r) => r.method === "POST");
    expect(post?.path).toBe(`/activities/${RUN_ID}`);
    const body = post?.body as [string, string][];
    expect(body[0]).toEqual(["_method", "patch"]);
    expect(body.filter(([name]) => name === "activity[visibility]")).toEqual([
      ["activity[visibility]", "only_me"],
    ]);
  });

  it("writes a multi-line private note", async () => {
    const note = "Merged by cameld (synthetic)\nsecond line";
    const values = await open().setPrivateNote(RIDE_ID, note);
    expect(values.privateNote).toBe(note);
    expect(fake.activities.get(RIDE_ID)?.commute).toBe(true);
  });

  it("sets and clears perceived exertion", async () => {
    const session = open();
    expect(await session.setPerceivedExertion(RIDE_ID, 7)).toMatchObject({
      perceivedExertion: 7,
      preferPerceivedExertion: true,
    });
    expect(await session.setPerceivedExertion(RIDE_ID, null, false)).toMatchObject({
      perceivedExertion: null,
      preferPerceivedExertion: false,
    });
  });

  it("rejects bad input before touching the browser", async () => {
    const session = open();
    await expect(session.setPerceivedExertion(RIDE_ID, 11)).rejects.toBeInstanceOf(RangeError);
    await expect(session.setPerceivedExertion(RIDE_ID, 2.5)).rejects.toBeInstanceOf(RangeError);
    await expect(session.setPerceivedExertion(RIDE_ID, 0)).rejects.toBeInstanceOf(RangeError);
    await expect(
      session.setVisibility(RIDE_ID, "public" as unknown as "only_me"),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(session.getEditForm(-1)).rejects.toBeInstanceOf(RangeError);
    await expect(session.exportOriginal(1.5)).rejects.toBeInstanceOf(RangeError);
    expect(fake.requests).toEqual([]);
  });

  it("fails verification when the save did not stick or moved another field", async () => {
    const session = open();
    fake.mode = "ignore_patch";
    const ignored = await session.setVisibility(RUN_ID, "only_me").catch((e: unknown) => e);
    expect(ignored).toBeInstanceOf(WebVerificationError);
    expect((ignored as WebVerificationError).fields).toEqual(["activity[visibility]"]);
    fake.mode = "patch_side_effect";
    const moved = await session.setVisibility(RUN_ID, "only_me").catch((e: unknown) => e);
    expect((moved as WebVerificationError).fields).toEqual(["activity[hide_from_home]"]);
  });

  it("falls back to the form token when the page has no csrf meta tag", async () => {
    fake.mode = "no_meta";
    const form = await open().getEditForm(RUN_ID);
    expect(form.csrfToken).toBe(form.authenticityToken);
    expect((await open().setPrivateNote(RUN_ID, "x")).privateNote).toBe("x");
  });

  it("reports a page without the activity form", async () => {
    fake.mode = "no_form";
    await expect(open({ formHydrationTimeoutMs: 500 }).getEditForm(RUN_ID)).rejects.toBeInstanceOf(
      WebUnexpectedResponseError,
    );
  });
});

describe("form hydration", () => {
  const posts = () => fake.requests.filter((r) => r.method === "POST");

  it("waits for the visibility radios before reading the form", async () => {
    fake.mode = "late_hydration";
    const started = Date.now();
    const form = await open().getEditForm(RIDE_ID);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(form.values.visibility).toBe("followers_only");
    expect(form.entries).toContainEqual(["activity[visibility]", "followers_only"]);
  });

  it("waits before editing, so the save keeps the current visibility", async () => {
    fake.mode = "late_hydration";
    const session = open();
    const note = "synthetic hydrated note";
    expect(await session.setPrivateNote(RIDE_ID, note)).toMatchObject({
      privateNote: note,
      visibility: "followers_only",
    });
    expect(fake.activities.get(RIDE_ID)).toMatchObject({
      privateNote: note,
      visibility: "followers_only",
      commute: true,
    });
    expect((await session.setVisibility(RIDE_ID, "only_me")).visibility).toBe("only_me");
    const body = posts()[0]?.body as [string, string][];
    expect(body).toContainEqual(["activity[visibility]", "followers_only"]);
  });

  it("throws WebNotReadyError and never posts when the page never hydrates", async () => {
    fake.mode = "never_hydrates";
    const session = open({ formHydrationTimeoutMs: 1000 });
    const read = await session.getEditForm(RIDE_ID).catch((e: unknown) => e);
    expect(read).toBeInstanceOf(WebNotReadyError);
    expect((read as WebNotReadyError).code).toBe("not_ready");
    expect((read as WebNotReadyError).fields).toEqual(["activity[visibility]"]);
    await expect(session.setVisibility(RIDE_ID, "only_me")).rejects.toBeInstanceOf(
      WebNotReadyError,
    );
    await expect(session.setPrivateNote(RIDE_ID, "x")).rejects.toBeInstanceOf(WebNotReadyError);
    await expect(session.deleteActivity(RIDE_ID, authorize(RIDE_ID))).rejects.toBeInstanceOf(
      WebNotReadyError,
    );
    expect(posts()).toEqual([]);
    expect(fake.activities.get(RIDE_ID)).toMatchObject({
      visibility: "followers_only",
      privateNote: "",
      exists: true,
    });
  });
});

describe("challenges and expiry", () => {
  it("throws LoginRequired on an expired session and sends no write", async () => {
    fake.expireSessions();
    await expect(open().setVisibility(RUN_ID, "only_me")).rejects.toBeInstanceOf(
      LoginRequiredError,
    );
    expect(fake.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it.each([
    ["captcha", "captcha"],
    ["forbidden", "forbidden"],
    ["rate_limited", "rate_limited"],
  ] as const)("throws ChallengeError for %s without retrying", async (mode, kind) => {
    fake.mode = mode;
    const error = await open()
      .exportOriginal(RUN_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChallengeError);
    expect((error as ChallengeError).kind).toBe(kind);
    expect(fake.requests.filter((r) => r.path === "/dashboard")).toHaveLength(1);
  });
});

describe("timeouts and serialization", () => {
  it("times out, closes its page, and lets the next operation run", async () => {
    const before = context().pages().length;
    const session = open({ operationTimeoutMs: 1000 });
    fake.mode = "slow_edit";
    fake.slowMs = 3000;
    await expect(session.getEditForm(RUN_ID)).rejects.toBeInstanceOf(WebTimeoutError);
    await expect.poll(() => context().pages().length).toBe(before);
    fake.mode = "normal";
    expect((await session.getEditForm(RUN_ID)).values.visibility).toBe("everyone");
  });

  it("runs one operation at a time, in call order", async () => {
    const session = open();
    let openPages = 0;
    let maxOpen = 0;
    const onPage = (page: { once(event: "close", cb: () => void): void }) => {
      openPages += 1;
      maxOpen = Math.max(maxOpen, openPages);
      page.once("close", () => {
        openPages -= 1;
      });
    };
    context().on("page", onPage);
    const order: number[] = [];
    await Promise.all(
      [RUN_ID, RIDE_ID, RUN_ID].map((id, i) => session.getEditForm(id).then(() => order.push(i))),
    );
    context().off("page", onPage);
    expect(order).toEqual([0, 1, 2]);
    expect(maxOpen).toBe(1);
  });

  it("disconnect leaves the browser, its pages and its cookies alive", async () => {
    const keep = await context().newPage();
    await keep.goto(`${fake.baseUrl}/dashboard`);
    const session = open();
    expect((await session.health()).loggedIn).toBe(true);
    await session.disconnect();
    expect(chrome.process.exitCode).toBeNull();
    expect(keep.isClosed()).toBe(false);
    // A later operation reconnects and still finds the logged-in profile.
    expect((await session.health()).loggedIn).toBe(true);
    await keep.close();
  });
});

describe("delete", () => {
  it("posts _method=delete to exactly /activities/<id> and confirms it is gone", async () => {
    const auth = authorize(RIDE_ID);
    const result = await open().deleteActivity(RIDE_ID, auth);
    expect(result.activityId).toBe(RIDE_ID);
    expect(auth.consumed).toBe(true);
    expect(fake.activities.get(RIDE_ID)?.exists).toBe(false);
    const posts = fake.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe(`/activities/${RIDE_ID}`);
    const body = posts[0]?.body as [string, string][];
    expect(body.slice(0, 1)).toEqual([["_method", "delete"]]);
    expect(fake.activities.get(RUN_ID)?.exists).toBe(true);
  });

  it.each([
    ["expire_after_delete", LoginRequiredError],
    ["captcha_after_delete", ChallengeError],
  ] as const)("reports an unknown outcome, not success, for %s", async (mode, type) => {
    fake.mode = mode;
    const error = await open()
      .deleteActivity(RIDE_ID, authorize(RIDE_ID))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(type);
    expect((error as Error).message).toMatch(/sent but unconfirmed/);
  });

  it("does not take a redirect to an unrelated page as proof", async () => {
    fake.mode = "odd_redirect_after_delete";
    await expect(open().deleteActivity(RIDE_ID, authorize(RIDE_ID))).rejects.toBeInstanceOf(
      DeletionNotConfirmedError,
    );
  });

  it("passes other failures of the delete request through", async () => {
    fake.mode = "delete_fails";
    await expect(open().deleteActivity(RIDE_ID, authorize(RIDE_ID))).rejects.toBeInstanceOf(
      WebUnexpectedResponseError,
    );
    expect(fake.activities.get(RIDE_ID)?.exists).toBe(true);
  });

  it("throws when the activity survives the delete", async () => {
    fake.mode = "keep_after_delete";
    await expect(open().deleteActivity(RIDE_ID, authorize(RIDE_ID))).rejects.toBeInstanceOf(
      DeletionNotConfirmedError,
    );
  });

  it("refuses forged, mismatched and reused authorizations before sending anything", async () => {
    const session = open();
    const forged = { activityId: RIDE_ID } as unknown as DeletionAuthorization;
    await expect(session.deleteActivity(RIDE_ID, forged)).rejects.toBeInstanceOf(
      DeletionUnauthorizedError,
    );
    await expect(session.deleteActivity(RIDE_ID, authorize(RUN_ID))).rejects.toBeInstanceOf(
      DeletionUnauthorizedError,
    );
    const auth = authorize(RIDE_ID);
    fake.expireSessions();
    await expect(session.deleteActivity(RIDE_ID, auth)).rejects.toBeInstanceOf(LoginRequiredError);
    await logIn();
    await expect(session.deleteActivity(RIDE_ID, auth)).rejects.toBeInstanceOf(
      DeletionUnauthorizedError,
    );
    expect(fake.requests.some((r) => r.method === "POST")).toBe(false);
    expect(fake.activities.get(RIDE_ID)?.exists).toBe(true);
  });
});

describe("photos", () => {
  it("downloads a photo with a plain GET", async () => {
    const photo = await open().downloadPhoto(`${fake.baseUrl}/media/synthetic-photo.png`);
    expect(photo.bytes.equals(SYNTHETIC_PNG)).toBe(true);
    expect(photo.contentType).toBe("image/png");
  });

  it("labels a photo without a content type as octet-stream", async () => {
    const session = open({
      fetch: () => Promise.resolve(new Response(new Uint8Array(SYNTHETIC_PNG))),
    });
    const photo = await session.downloadPhoto("https://cdn.example.test/p.png");
    expect(photo.contentType).toBe("application/octet-stream");
  });

  it("rejects bad photo URLs and failed downloads", async () => {
    const session = open();
    await expect(session.downloadPhoto("ftp://example.test/x.png")).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(session.downloadPhoto(`${fake.baseUrl}/media/missing.png`)).rejects.toBeInstanceOf(
      WebUnexpectedResponseError,
    );
  });

  it("attaches a photo in three steps and keeps the existing one", async () => {
    const result = await open().attachPhoto(RUN_ID, {
      bytes: SYNTHETIC_PNG,
      contentType: "image/png",
      takenAt: new Date("2030-04-01T06:05:00Z"),
      athleteId: SYNTHETIC_ATHLETE_ID,
    });
    expect(result.verified).toBe(true);
    const photos = fake.activities.get(RUN_ID)?.photos ?? [];
    expect(photos.map((p) => p.uuid)).toEqual(["synthetic-photo-0001", result.uuid]);
    expect(photos[1]?.rank).toBe(2);
    const metadata = fake.requests.find((r) => r.path === "/photos/metadata");
    expect(metadata?.body).toMatchObject({
      athlete_id: SYNTHETIC_ATHLETE_ID,
      uuid: result.uuid,
      taken_at: "2030-04-01T06:05:00.000Z",
    });
    const upload = fake.requests.find((r) => r.path === `/upload-bucket/${result.uuid}`);
    expect(upload?.body).toBe(SYNTHETIC_PNG.length);
  });

  it("reports an unusable metadata answer and an unverified attach", async () => {
    const session = open();
    const photo = {
      bytes: SYNTHETIC_PNG,
      contentType: "image/png",
      takenAt: new Date("2030-04-01T06:05:00Z"),
      athleteId: SYNTHETIC_ATHLETE_ID,
    };
    fake.mode = "bad_metadata";
    await expect(session.attachPhoto(RUN_ID, photo)).rejects.toBeInstanceOf(
      WebUnexpectedResponseError,
    );
    fake.mode = "hide_new_photos";
    expect((await session.attachPhoto(RUN_ID, photo)).verified).toBe(false);
    await expect(session.attachPhoto(RUN_ID, { ...photo, athleteId: 0 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(
      session.attachPhoto(RUN_ID, { ...photo, takenAt: new Date("nope") }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe("login", () => {
  it("logs in with the emailed code from the relay", async () => {
    fake.expireSessions();
    const session = open({ email: SYNTHETIC_EMAIL, relay: relayFor(fake) });
    await session.login();
    expect((await session.health()).loggedIn).toBe(true);
    const otp = fake.requests.find((r) => r.path === "/login/request_otp");
    expect(otp?.body).toEqual({ email: SYNTHETIC_EMAIL });
    expect(logLines.some((l) => l.includes(SYNTHETIC_EMAIL))).toBe(false);
  });

  it("returns at once when the profile is still logged in", async () => {
    await open({ email: SYNTHETIC_EMAIL, relay: relayFor(fake) }).login();
    expect(fake.requests.some((r) => r.path === "/login/request_otp")).toBe(false);
  });

  it("tries once: a refused request_otp needs the owner until health recovers", async () => {
    fake.expireSessions();
    fake.mode = "otp_refused";
    const session = open({ email: SYNTHETIC_EMAIL, relay: relayFor(fake) });
    await expect(session.login()).rejects.toBeInstanceOf(LoginRequiredError);
    fake.requests.length = 0;
    await expect(session.login()).rejects.toThrow(/already failed/);
    expect(fake.requests).toEqual([]);
    // The owner logs in by hand; a healthy check re-arms automation.
    fake.mode = "normal";
    await logIn();
    expect((await session.health()).loggedIn).toBe(true);
    await session.login();
  });

  it("throws LoginRequired when the code never arrives or is rejected", async () => {
    fake.expireSessions();
    await expect(
      open({ email: SYNTHETIC_EMAIL, relay: relayFor(fake, "timeout") }).login(),
    ).rejects.toThrow(/did not arrive/);
    fake.acceptCodes = false;
    await expect(
      open({ email: SYNTHETIC_EMAIL, relay: relayFor(fake), navigationTimeoutMs: 2000 }).login(),
    ).rejects.toThrow(/did not accept/);
  });

  it("passes relay programming errors through untouched", async () => {
    fake.expireSessions();
    await expect(
      open({ email: SYNTHETIC_EMAIL, relay: relayFor(fake, "broken") }).login(),
    ).rejects.toThrow("synthetic relay bug");
  });

  it("does not trust a session without the athlete menu", async () => {
    fake.mode = "no_menu";
    await expect(open({ email: SYNTHETIC_EMAIL, relay: relayFor(fake) }).login()).rejects.toThrow(
      /athlete menu is missing/,
    );
  });

  it("throws LoginRequired when challenged or not configured", async () => {
    fake.expireSessions();
    fake.mode = "captcha";
    await expect(open({ email: SYNTHETIC_EMAIL, relay: relayFor(fake) }).login()).rejects.toThrow(
      /challenged/,
    );
    await expect(open().login()).rejects.toThrow(/not configured/);
  });
});
