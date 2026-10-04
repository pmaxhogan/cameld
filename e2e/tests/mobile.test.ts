import type { Page } from "@playwright/test";
import { SEED } from "../support/constants.ts";
import { expect, test } from "./auth.ts";

// Phone width. Read-only: ui.test.ts runs after this file against the same
// seeded server and expects the seeded state (frozen writes, a review item).
test.use({ viewport: { width: 390, height: 844 } });

/** Neither the page nor the main pane may scroll sideways. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = async (selector: string) =>
    page.locator(selector).evaluate((el) => el.scrollWidth - el.clientWidth);
  expect({ page: await overflow("html"), main: await overflow("main") }).toEqual({
    page: 0,
    main: 0,
  });
}

test("backfill cards stack at 390px without sideways scrolling", async ({ signedIn: page }) => {
  await page.goto("/#/backfill");
  const strava = page.getByTestId("rate-budget");
  const cameld = page.getByTestId("cameld-budget");
  await expect(cameld).toBeVisible();
  const a = (await strava.boundingBox())!;
  const b = (await cameld.boundingBox())!;
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
  expect(Math.abs(a.x - b.x)).toBeLessThan(1);
  expect(a.width).toBeLessThanOrEqual(390);
  await expect(page.getByTestId("backfill-danger")).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("the frozen banner keeps its Unfreeze button whole at 390px", async ({ signedIn: page }) => {
  const button = page.getByTestId("unfreeze-button");
  await expect(button).toBeVisible();
  const fit = await button.evaluate((el) => ({
    clipped: el.scrollWidth > el.clientWidth,
    right: el.getBoundingClientRect().right,
  }));
  expect(fit.clipped).toBe(false);
  expect(fit.right).toBeLessThanOrEqual(390);
});

test("history table scrolls inside its own box at 390px", async ({ signedIn: page }) => {
  await page.goto("/#/history");
  await expect(page.getByTestId("history-row").first()).toBeVisible();
  const scroller = page
    .getByTestId("history-table")
    .locator("xpath=ancestor::div[contains(@class, 'table-scroll')]");
  await expect(scroller).toHaveCSS("overflow-x", "auto");
  expect((await scroller.boundingBox())!.width).toBeLessThanOrEqual(390);
  await expectNoHorizontalScroll(page);
});

test("every other screen fits 390px", async ({ signedIn: page }) => {
  for (const [hash, testid] of [
    [`/#/history/${SEED.parkedGroup}`, "track-comparison"],
    [`/#/history/${SEED.doneGroup}`, "writes-table"],
    ["/#/review", "review-item"],
    ["/#/settings", "settings-save"],
    ["/#/no-such-page", "not-found"],
  ] as const) {
    await page.goto(hash);
    await expect(page.getByTestId(testid).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
});
