import { expect, test } from "./fixtures";

test.describe("Analytics dashboard", () => {
  test("loads the analytics page for an admin", async ({ page }) => {
    await page.goto("/dashboard/analytics");

    await expect(page).toHaveURL(/\/dashboard\/analytics/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("renders without a server error", async ({ page }) => {
    const response = await page.goto("/dashboard/analytics");

    expect(response?.status()).toBeLessThan(400);
    await expect(page.getByText(/application error|internal server error/i)).toHaveCount(0);
  });
});
