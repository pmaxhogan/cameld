import { expect, test } from "@playwright/test";
import { OWNER } from "../support/constants.ts";
import { accessToken, passAccess, signIn } from "./auth.ts";

test("GET /healthz returns ok and a version with no credentials", async ({ request }) => {
  const response = await request.get("/healthz");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { ok: boolean; version: string };
  expect(body.ok).toBe(true);
  expect(body.version.length).toBeGreaterThan(0);
});

test("/api is 401 without auth, and without the password session", async ({
  playwright,
  baseURL,
}) => {
  const anonymous = await playwright.request.newContext({ baseURL });
  for (const path of ["/api/status", "/api/settings", "/api/review", "/%61pi/status"]) {
    expect((await anonymous.get(path)).status()).toBe(401);
  }
  expect((await anonymous.get("/")).status()).toBe(401);
  const accessOnly = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { "cf-access-jwt-assertion": await accessToken() },
  });
  expect((await accessOnly.get("/api/status")).status()).toBe(401);
  const stranger = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { "cf-access-jwt-assertion": await accessToken("stranger@example.com") },
  });
  expect((await stranger.get("/login")).status()).toBe(401);
  await Promise.all([anonymous.dispose(), accessOnly.dispose(), stranger.dispose()]);
});

test("the login gate refuses a wrong password and lets the owner in", async ({
  page,
  context,
  baseURL,
}) => {
  await passAccess(context, baseURL as string);
  await signIn(page, "not-the-password");
  await expect(page.getByRole("alert")).toHaveText("Wrong password.");
  await page.getByLabel("Backup password").fill("synthetic-e2e-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("identity")).toContainText(OWNER);
  const cookie = (await context.cookies()).find((c) => c.name === "cameld_session");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.secure).toBe(true);
  expect(cookie?.sameSite).toBe("Strict");
  await page.getByTestId("logout").click();
  await expect(page).toHaveURL(/\/login$/);
});
