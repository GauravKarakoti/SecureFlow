import { expect, test as base } from "@playwright/test";

test.describe("Authentication", () => {
  base(
    "unauthenticated user visiting the dashboard is redirected to login",
    async ({ page, baseURL }) => {
      await page.goto(`${baseURL ?? "http://localhost:9002"}/dashboard`);
      await page.waitForURL(/\/login/);
      await expect(page.getByTestId("github-sign-in-button")).toBeVisible();
    },
  );

  base("login page renders the GitHub sign-in call to action", async ({ page, baseURL }) => {
    await page.goto(`${baseURL ?? "http://localhost:9002"}/login`);
    await expect(page.getByTestId("github-sign-in-button")).toBeVisible();
    await expect(page.getByText(/sign in with github/i)).toBeVisible();
  });

  base(
    "signing in with GitHub lands the user on the Mission Control dashboard",
    async ({ page, baseURL }) => {
      await page.goto(`${baseURL ?? "http://localhost:9002"}/login`);
      await page.getByTestId("github-sign-in-button").click();
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
      await expect(page.getByTestId("dashboard-nav")).toBeVisible();
    },
  );
});
