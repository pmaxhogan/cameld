import { type Browser, chromium } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { listGroups } from "../src/state/repo.ts";
import { WebSession } from "../src/web/session.ts";
import { type CdpChromium, launchCdpChromium } from "./fake-strava/chromium.ts";
import type { FakeActivity } from "./fake-strava/fixtures.ts";
import { type FakeStrava, startFakeStrava } from "./fake-strava/server.ts";
import type { WorldActivity } from "./fake-strava-api/world.ts";
import { addOuting } from "./fixtures/synthetic-outings.ts";
import { createHarness, type Harness } from "./machine-harness.ts";

/**
 * The state machine end to end with the REAL WebSession: a real Chromium
 * over CDP drives the fake strava.com pages (export, edit form, delete),
 * while the fake API server answers uploads and the 404 confirmation. The
 * two fakes share activity existence, so a web delete is what makes the API
 * answer 404. All data is synthetic.
 */

let chrome: CdpChromium;
let web: FakeStrava;
let observer: Browser;
let h: Harness | undefined;
const sessions: WebSession[] = [];

function toFake(a: WorldActivity): FakeActivity {
  return {
    id: a.id,
    exists: true,
    name: a.name,
    description: a.description ?? "",
    sportType: a.sportType,
    privateNote: a.privateNote,
    visibility: a.visibility,
    perceivedExertion: a.perceivedExertion === null ? "" : String(a.perceivedExertion),
    preferPerceivedExertion: a.preferPerceivedExertion,
    hideFromHome: a.hideFromHome,
    commute: a.commute,
    photos: [],
    original: {
      filename: a.original?.filename ?? "none.fit",
      contentType: "application/octet-stream",
      bytes: a.original?.bytes ?? Buffer.alloc(0),
    },
    gpx: "",
  };
}

beforeAll(async () => {
  chrome = await launchCdpChromium();
  web = await startFakeStrava();
  observer = await chromium.connectOverCDP(chrome.cdpUrl);
  const context = observer.contexts()[0]!;
  const page = await context.newPage();
  await page.goto(web.sessionUrl);
  await page.close();
}, 60_000);

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.disconnect();
  await h?.close();
  h = undefined;
});

afterAll(async () => {
  await observer?.close();
  await web?.close();
  await chrome?.close();
});

describe("state machine with the real web session", () => {
  it("runs path B: exports originals, deletes both through the web, confirms by API 404", async () => {
    h = await createHarness({
      settings: { switches: { delete: true } },
      webSession: (clock) => {
        const session = new WebSession({
          cdpUrl: chrome.cdpUrl,
          baseUrl: web.baseUrl,
          clock,
          navigationTimeoutMs: 10_000,
          operationTimeoutMs: 30_000,
        });
        sessions.push(session);
        return session;
      },
    });
    const harness = h;
    const outing = addOuting(harness.world);
    for (const a of [outing.app, outing.fitbit]) web.activities.set(a.id, toFake(a));
    harness.world.onCreated = (a) => web.activities.set(a.id, toFake(a));
    harness.world.goneElsewhere = (id) => web.activities.get(id)?.exists === false;

    await harness.poller.poll();
    const group = listGroups(harness.db)[0]!;
    expect(group.lastError).toBeNull();
    expect(group.status).toBe("done");
    expect(web.activities.get(outing.fitbit.id)?.exists).toBe(false);
    expect(web.activities.get(outing.app.id)?.exists).toBe(false);
    const merged = web.activities.get(group.mergedActivityId!)!;
    expect(merged.privateNote).toContain("merged by cameld");
    expect(merged.perceivedExertion).toBe("6");
    expect(web.requests.some((r) => r.path === "/session")).toBe(false);
    expect(harness.world.get(outing.app.id)).toBeUndefined();
  }, 120_000);
});
