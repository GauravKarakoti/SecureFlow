import { expect, test } from "./fixtures";

test.describe("AI health dashboard", () => {
  test("loads the AI health page for an admin", async ({ page }) => {
    await page.goto("/dashboard/ai-health");

    await expect(page).toHaveURL(/\/dashboard\/ai-health/);
    await expect(
      page.getByRole("heading", { level: 1, name: /circuit breaker health/i }),
    ).toBeVisible();
  });

  test("shows the model circuit breaker status matrix", async ({ page }) => {
    await page.goto("/dashboard/ai-health");

    await expect(
      page.getByRole("heading", { level: 2, name: /model circuit breaker status matrix/i }),
    ).toBeVisible();
  });
});
