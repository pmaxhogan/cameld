import { expect, test } from "@playwright/test";

test("GET /healthz returns ok and a version", async ({ request }) => {
  const response = await request.get("/healthz");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { ok: boolean; version: string };
  expect(body.ok).toBe(true);
  expect(body.version.length).toBeGreaterThan(0);
});

test("the web root renders and shows the server version", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "cameld" })).toBeVisible();
  await expect(page.getByTestId("version")).toContainText("server ");
  await expect(page.getByTestId("map")).toBeVisible();
});
