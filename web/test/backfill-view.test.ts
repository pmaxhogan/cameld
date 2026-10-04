import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import BackfillView from "../src/views/BackfillView.vue";
import { MATCH, apiStatus, backfillInfo } from "./fixtures.ts";
import { allByTestId, byTestId, click, mountUi, setValue, stubApi, type Reply } from "./helpers.ts";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
});

const REPORT = {
  generatedAt: 5_000_000,
  progress: backfillInfo().progress,
  groups: [
    {
      groupKey: "k1",
      startMs: 1_000_000,
      decision: "auto",
      report: { members: [{}, {}], match: MATCH, noLoss: { ok: true, points: 1200 } },
    },
  ],
};

async function mountBackfill(
  status = apiStatus(),
  extra: Record<string, Reply | ((init: RequestInit | undefined) => Reply)> = {},
) {
  const api = stubApi({
    "GET /api/backfill": { body: status.backfill },
    "GET /api/backfill/report": { body: REPORT },
    ...extra,
  });
  const wrapper = mountUi(BackfillView, { props: { status } });
  unmount = () => wrapper.unmount();
  await flushPromises();
  return api;
}

describe("BackfillView", () => {
  it("explains activities without an original file and pending retries", async () => {
    await mountBackfill(
      apiStatus({ originals: { present: 40, pending: 3, unavailable: 7, backingOff: 2 } }),
    );
    expect(byTestId("originals-present")?.textContent).toContain("40");
    expect(byTestId("originals-pending")?.textContent?.replace(/\s+/g, " ")).toContain(
      "3 (2 waiting to retry after a failed export)",
    );
    expect(byTestId("originals-unavailable")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "7 activities have no original file; they will be backed up from streams and never deleted.",
    );
  });

  it("uses the singular for one activity and hides the note when there are none", async () => {
    await mountBackfill(
      apiStatus({ originals: { present: 1, pending: 0, unavailable: 1, backingOff: 0 } }),
    );
    expect(byTestId("originals-unavailable")?.textContent).toContain("1 activity has no original");
    expect(byTestId("originals-pending")?.textContent?.trim()).toBe("0");
    unmount?.();
    await mountBackfill();
    expect(byTestId("originals-unavailable")).toBeNull();
  });

  it("shows budget, login health, progress and the dry-run report", async () => {
    await mountBackfill();
    const strava = byTestId("rate-budget")!.textContent;
    expect(strava).toContain("Strava app usage (all consumers)");
    expect(strava).toContain("50 / 200");
    expect(strava).toContain("25 / 100");
    const cameld = byTestId("cameld-budget")!.textContent;
    expect(cameld).toContain("cameld budget");
    expect(byTestId("cameld-budget-fifteen")?.textContent).toContain("6 / 40, 34 left");
    expect(byTestId("cameld-budget-daily")?.textContent).toContain("34 / 500, 466 left");
    expect(byTestId("reads-today")?.textContent).toContain("34 of 500 (cameld daily cap)");
    expect(byTestId("budget-left")?.textContent).toContain("34 reads now");
    expect(byTestId("budget-left")?.textContent).toContain("cameld 15-minute cap");
    expect(byTestId("login-health")?.textContent).toContain("healthy");
    expect(byTestId("login-health")?.querySelector("a")?.getAttribute("href")).toBe("#/browser");
    const progress = byTestId("backfill-progress")!.textContent;
    expect(progress).toContain("12");
    expect(byTestId("backfill-last-batch")).toBeNull();
    expect(byTestId("backfill-message")).toBeNull();
    const table = byTestId("dry-run-table")!.textContent;
    expect(table).toContain("auto");
    expect(table).toContain("93%");
    expect(table).toContain("8.3 m");
    expect(table).toContain("ok (1200 points)");
    expect(byTestId("backfill-pause")?.textContent).toContain("Pause");
  });

  it("shows the no-data, unhealthy, paused and last-batch states", async () => {
    const info = backfillInfo({
      paused: true,
      running: true,
      progress: { activities: 0, cursorMs: null, done: true, readsToday: 0 },
      lastBatch: {
        mode: "dry_run",
        stopped: "budget",
        budgetLimit: "daily",
        activities: 5,
        groups: 2,
        error: "boom",
        finishedAt: 1,
      },
    });
    await mountBackfill(
      apiStatus({ rate: null, web: { healthy: false, reason: "login expired" }, backfill: info }),
      { "GET /api/backfill/report": { body: { ...REPORT, groups: [] } } },
    );
    expect(byTestId("rate-budget")?.textContent).toContain("No Strava data yet");
    expect(byTestId("login-health")?.textContent).toContain("login expired");
    expect(byTestId("backfill-progress")?.textContent).toContain("yes (paused)");
    expect(byTestId("backfill-last-batch")?.textContent).toContain(
      "stopped: budget (cameld daily cap), error: boom",
    );
    const empty = byTestId("dry-run-empty")!.textContent;
    expect(empty).toContain("only while the backfill runs in dry_run mode");
    expect(empty).toContain("The current mode is off");
    expect(byTestId("backfill-pause")?.textContent).toContain("Resume");
    expect((byTestId("backfill-start") as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains an empty report in dry_run mode without the mode hint", async () => {
    const info = backfillInfo({ mode: "dry_run" });
    await mountBackfill(apiStatus({ backfill: info }), {
      "GET /api/backfill/report": { body: { ...REPORT, groups: [] } },
    });
    const empty = byTestId("dry-run-empty")!.textContent;
    expect(empty).toContain("dry_run");
    expect(empty).not.toContain("The current mode is");
  });

  it("shows a last batch without an error and load failures", async () => {
    await mountBackfill(apiStatus(), {
      "GET /api/backfill": {
        body: backfillInfo({
          lastBatch: {
            mode: "live",
            stopped: "done",
            budgetLimit: null,
            activities: 1,
            groups: 0,
            error: null,
            finishedAt: 1,
          },
        }),
      },
      "GET /api/backfill/report": { status: 500, body: { error: "db_down" } },
    });
    expect(byTestId("backfill-last-batch")?.textContent).not.toContain("error");
    expect(byTestId("dry-run-error")?.textContent).toContain("db_down");
    unmount?.();
    await mountBackfill(apiStatus(), {
      "GET /api/backfill": { status: 500, body: { error: "x" } },
    });
    expect(byTestId("backfill-message")?.textContent).toContain("x");
  });

  it("saves mode and budgets", async () => {
    const { calls } = await mountBackfill(apiStatus(), {
      "PATCH /api/backfill": (init) => ({
        body: backfillInfo({
          ...JSON.parse(String(init?.body)),
          budget: {
            ...backfillInfo().budget,
            dailyReads: 300,
            fifteenMinuteReads: 20,
            remaining: 1,
          },
        }),
      }),
    });
    setValue("backfill-mode", "dry_run");
    setValue("backfill-daily", "300");
    setValue("backfill-fifteen", "20");
    click("backfill-save");
    await flushPromises();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({
      mode: "dry_run",
      dailyReads: 300,
      fifteenMinuteReads: 20,
    });
    expect(byTestId("backfill-message")?.textContent).toContain("Backfill settings saved");
    expect((byTestId("backfill-mode") as HTMLSelectElement).value).toBe("dry_run");
  });

  it("asks for the typed phrase when the server requires it", async () => {
    let confirmOk = false;
    const { calls } = await mountBackfill(apiStatus(), {
      "PATCH /api/backfill": (init) => {
        const body = JSON.parse(String(init?.body)) as { confirm?: string };
        if (body.confirm === undefined) return { status: 409, body: { error: "confirm_required" } };
        if (!confirmOk) return { status: 400, body: { error: "bad_phrase" } };
        return { body: backfillInfo({ mode: "live" }) };
      },
    });
    setValue("backfill-mode", "live");
    click("backfill-save");
    await flushPromises();
    expect(byTestId("delete-confirm-dialog")).not.toBeNull();
    expect((byTestId("delete-confirm-submit") as HTMLButtonElement).disabled).toBe(true);
    setValue("delete-confirm-input", "delete originals");
    await flushPromises();
    click("delete-confirm-submit");
    await flushPromises();
    expect(byTestId("delete-confirm-error")?.textContent).toContain("bad_phrase");
    confirmOk = true;
    click("delete-confirm-submit");
    await flushPromises();
    expect(calls.filter((c) => c.method === "PATCH").at(-1)!.body).toMatchObject({
      mode: "live",
      confirm: "delete originals",
    });
    expect(byTestId("delete-confirm-dialog")).toBeNull();
  });

  it("cancels the phrase dialog and reports other save errors", async () => {
    let status = 409;
    await mountBackfill(apiStatus(), {
      "PATCH /api/backfill": () => ({
        status,
        body: { error: status === 409 ? "confirm_required" : "invalid" },
      }),
    });
    click("backfill-save");
    await flushPromises();
    click("delete-confirm-cancel");
    await flushPromises();
    expect(byTestId("delete-confirm-dialog")).toBeNull();
    status = 400;
    click("backfill-save");
    await flushPromises();
    expect(byTestId("delete-confirm-dialog")).toBeNull();
    expect(byTestId("backfill-message")?.textContent).toContain("invalid");
  });

  it("sends start, pause, resume and a confirmed reset", async () => {
    let paused = false;
    const { calls } = await mountBackfill(apiStatus(), {
      "POST /api/backfill/control": (init) => {
        const { action } = JSON.parse(String(init?.body)) as { action: string };
        if (action === "reset") return { status: 409, body: { error: "running" } };
        paused = action === "pause";
        return { body: backfillInfo({ paused }) };
      },
    });
    click("backfill-start");
    await flushPromises();
    click("backfill-pause");
    await flushPromises();
    expect(byTestId("backfill-pause")?.textContent).toContain("Resume");
    click("backfill-pause");
    await flushPromises();
    click("backfill-reset");
    await flushPromises();
    click("backfill-reset-cancel");
    await flushPromises();
    expect(byTestId("backfill-reset-confirm")).toBeNull();
    click("backfill-reset");
    await flushPromises();
    document.querySelector<HTMLElement>(".p-dialog-close-button")!.click();
    await flushPromises();
    click("backfill-reset");
    await flushPromises();
    const confirm = byTestId("backfill-reset-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    setValue("backfill-reset-input", "res");
    await flushPromises();
    expect(confirm.disabled).toBe(true);
    setValue("backfill-reset-input", "reset");
    await flushPromises();
    expect(confirm.disabled).toBe(false);
    click("backfill-reset-confirm");
    await flushPromises();
    const actions = calls
      .filter((c) => c.method === "POST")
      .map((c) => (c.body as { action: string }).action);
    expect(actions).toEqual(["start", "pause", "resume", "reset"]);
    expect(byTestId("backfill-message")?.textContent).toContain("running");
    click("dry-run-refresh");
    await flushPromises();
    expect(allByTestId("dry-run-table")).toHaveLength(1);
  });
});
