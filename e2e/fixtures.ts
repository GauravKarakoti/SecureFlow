/* eslint-disable react-hooks/rules-of-hooks */
import { test as base, expect } from "@playwright/test";

/**
 * Shared Playwright fixture that logs in once and reuses the resulting
 * session cookie for every test in this file's project, instead of
 * clicking through the GitHub OAuth screen per test.
 *
 * VERIFY: NextAuth v5's session cookie name/value shape depends on your
 * `AUTH_SECRET` / provider config. The simplest reliable setup is a
 * dedicated test-only credentials/dev provider (or a seeded session
 * row) exposed only when `NODE_ENV=test`. Swap the `login()` body below
 * for whatever your app's test-auth strategy actually is -- everything
 * else in this suite only depends on the page being authenticated
 * afterward.
 */
export const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    await login(page, baseURL ?? "http://localhost:9002");
    await use(page);
  },
});

async function login(page: import("@playwright/test").Page, baseURL: string) {
  await page.goto(`${baseURL}/login`);
  await page.getByTestId("github-sign-in-button").click();
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
}

export { expect };
