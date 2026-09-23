import { expect, test } from "./fixtures";

test.describe("AI-generated patch flow", () => {
  test("generating a patch from a finding shows a diff and a copy/apply action", async ({
    page,
  }) => {
    await page.goto("/dashboard/findings");

    const rows = page.getByTestId("finding-row");
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
    await rows.first().click();

    await page.getByTestId("generate-patch-button").click();

    await expect(page.getByTestId("patch-loading-indicator")).toBeVisible();
    await expect(page.getByTestId("patch-loading-indicator")).toBeHidden({ timeout: 20_000 });

    await expect(page.getByTestId("patch-diff-view")).toBeVisible();
    await expect(page.getByTestId("copy-patch-button")).toBeEnabled();
  });

  test("shows a graceful error state if patch generation fails", async ({ page }) => {
    // Simulate the AI backend failing so the UI's error path is covered
    // without depending on being able to force a real model failure.
    await page.route("**/api/**/generate-patch", (route) =>
      route.fulfill({ status: 500, body: JSON.stringify({ error: "AI service unavailable" }) }),
    );

    await page.goto("/dashboard/findings");
    const rows = page.getByTestId("finding-row");
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
    await rows.first().click();

    await page.getByTestId("generate-patch-button").click();
    await expect(page.getByTestId("patch-error-message")).toBeVisible({ timeout: 10_000 });
  });
});
