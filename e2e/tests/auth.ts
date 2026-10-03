import { type BrowserContext, expect, type Page, test as base } from "@playwright/test";
import { OWNER, PASSWORD } from "../support/constants.ts";

/** A Cloudflare Access token for `email`, signed by the test double. */
export async function accessToken(email = OWNER): Promise<string> {
  const response = await fetch(
    `${process.env.CAMELD_E2E_DOUBLE_URL as string}/sign?email=${encodeURIComponent(email)}`,
  );
  return response.text();
}

/** What Cloudflare Access would leave behind: its CF_Authorization cookie. */
export async function passAccess(context: BrowserContext, baseURL: string, email = OWNER) {
  await context.addCookies([
    { name: "CF_Authorization", value: await accessToken(email), url: baseURL },
  ]);
}

export async function signIn(page: Page, password = PASSWORD): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Backup password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** GET an /api path from inside the signed-in page (same origin, its cookies). */
export async function api<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (url) => {
    const response = await fetch(url);
    return (await response.json()) as unknown;
  }, path) as Promise<T>;
}

/** A page that passed both gates (Access and the backup password). */
export const test = base.extend<{ signedIn: Page }>({
  signedIn: async ({ page, context, baseURL }, use) => {
    await passAccess(context, baseURL as string);
    await signIn(page);
    await expect(page.getByTestId("identity")).toContainText(OWNER);
    await use(page);
  },
});

export { expect };
