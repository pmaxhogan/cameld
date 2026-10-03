import { DELETE_CONFIRM_PHRASE } from "@cameld/shared";
import { SEED } from "../support/constants.ts";
import { api, expect, test } from "./auth.ts";

// The suite shares one seeded server and runs in file order with one worker.
test.describe.configure({ mode: "serial" });

test("frozen banner: shows the reason and unfreezes with a reason", async ({ signedIn: page }) => {
  const banner = page.getByTestId("frozen-banner");
  await expect(banner).toContainText(SEED.frozenReason);
  await page.getByTestId("unfreeze-button").click();
  await page.getByTestId("unfreeze-reason").fill("checked the synthetic evidence");
  await page.getByTestId("unfreeze-confirm").click();
  await expect(banner).toBeHidden();
});

test("review queue: compares the tracks and approves with a note", async ({ signedIn: page }) => {
  await page.getByTestId("nav-review").click();
  const item = page.getByTestId("review-item");
  await expect(item).toHaveCount(1);
  await item.first().click();
  await expect(page.getByTestId("review-metrics")).toContainText("97");
  await expect(page.getByTestId("map-side-app")).toBeVisible();
  await expect(page.getByTestId("map-side-fitbit")).toBeVisible();
  await expect(page.getByTestId("map-overlay")).toBeVisible();
  await page.getByTestId("review-note").fill("same synthetic loop");
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("review-result")).toBeVisible();
  await expect(page.getByTestId("review-empty")).toBeVisible();
  const body = (await api(page, `/api/groups/${SEED.reviewGroup}`)) as {
    group: { status: string };
    events: { event: string; evidence: unknown }[];
  };
  expect(body.group.status).toBe("scored");
  expect(body.events.at(-1)).toMatchObject({
    event: "review_approved",
    evidence: { note: "same synthetic loop" },
  });
});

test("history: event timeline, evidence and the restore action", async ({ signedIn: page }) => {
  await page.getByTestId("nav-history").click();
  await expect(page.getByTestId("history-row")).toHaveCount(3);
  await page.goto(`/#/history/${SEED.doneGroup}`);
  const detail = page.getByTestId("group-detail");
  await expect(detail).toBeVisible();
  await expect(page.getByTestId("event-item")).toHaveCount(12);
  await expect(page.getByTestId("event-timeline")).toContainText("confirmed");
  await expect(page.getByTestId("members-table")).toContainText("9000000201");
  await page.getByTestId("restore-button").click();
  await page.getByTestId("restore-reason").fill("synthetic restore drill");
  await page.getByTestId("restore-confirm").click();
  // No Strava connection in the suite: the server refuses, and says why.
  await expect(page.getByTestId("restore-error")).toContainText(/strava/i);
});

test("backfill: budget, login health, progress and the dry-run report", async ({
  signedIn: page,
}) => {
  await page.getByTestId("nav-backfill").click();
  await expect(page.getByTestId("rate-budget")).toBeVisible();
  await expect(page.getByTestId("login-health")).toContainText(/unhealthy|no_browser|not/i);
  await expect(page.getByTestId("backfill-progress")).toBeVisible();
  const table = page.getByTestId("dry-run-table");
  await expect(table).toContainText("needs_original");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await page.getByTestId("backfill-mode").selectOption("dry_run");
  await page.getByTestId("backfill-daily").fill("450");
  await page.getByTestId("backfill-save").click();
  await expect
    .poll(
      async () =>
        (await api(page, "/api/backfill")) as { mode: string; budget: { dailyReads: number } },
    )
    .toMatchObject({ mode: "dry_run", budget: { dailyReads: 450 } });
});

test("settings: the delete switch needs the typed phrase", async ({ signedIn: page }) => {
  await page.getByTestId("nav-settings").click();
  const toggle = page.getByTestId("switch-delete");
  await expect(toggle).not.toBeChecked();

  // Cancel leaves deletion off.
  await toggle.click();
  const dialog = page.getByTestId("delete-confirm-dialog");
  await expect(dialog).toBeVisible();
  await page.getByTestId("delete-confirm-cancel").click();
  await expect(toggle).not.toBeChecked();

  await toggle.click();
  const submit = page.getByTestId("delete-confirm-submit");
  await expect(submit).toBeDisabled();
  await page.getByTestId("delete-confirm-input").fill("delete");
  await expect(submit).toBeDisabled();
  await page.getByTestId("delete-confirm-input").fill(DELETE_CONFIRM_PHRASE);
  await submit.click();
  await expect(toggle).toBeChecked();
  const settings = (await api(page, "/api/settings")) as { switches: { delete: boolean } };
  expect(settings.switches.delete).toBe(true);

  // Thresholds save through the same form.
  await page.getByTestId("setting-grace-hours").fill("36");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-saved")).toBeVisible();
  const saved = (await api(page, "/api/settings")) as { timing: { gracePeriodMs: number } };
  expect(saved.timing.gracePeriodMs).toBe(36 * 3_600_000);
  const audit = (await api(page, "/api/audit")) as { action: string; actor: string }[];
  expect(audit.map((a) => a.action)).toContain("settings.update");
});

test("strava login: embeds the sidecar's browser through cameld's own origin", async ({
  signedIn: page,
}) => {
  await page.getByTestId("nav-browser").click();
  const frame = page.getByTestId("browser-frame");
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute("src", /^\/browser\//);
  await expect(page.frameLocator("[data-testid=browser-frame]").locator("#vnc")).toHaveText(
    "synthetic remote browser",
  );
  await page.getByTestId("browser-check").click();
  await expect(page.getByTestId("browser-health")).toBeVisible();
});
