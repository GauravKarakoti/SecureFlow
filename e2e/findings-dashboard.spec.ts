import { expect, test } from "./fixtures";

test.describe("Findings dashboard (Breach Attempts)", () => {
  test("lists security findings with severity and file info", async ({ page }) => {
    await page.goto("/dashboard/findings");

    await expect(page.getByTestId("findings-table")).toBeVisible();

    const rows = page.getByTestId("finding-row");
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });

    const firstRow = rows.first();
    await expect(firstRow.getByTestId("finding-severity")).toBeVisible();
    await expect(firstRow.getByTestId("finding-file")).toBeVisible();
  });

  test("filtering findings by severity narrows the results", async ({ page }) => {
    await page.goto("/dashboard/findings");
    await page.getByTestId("severity-filter").click();
    await page.getByRole("option", { name: /critical/i }).click();

    const rows = page.getByTestId("finding-row");
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });

    const severityBadges = await rows.getByTestId("finding-severity").allTextContents();
    for (const badge of severityBadges) {
      expect(badge.toUpperCase()).toContain("CRITICAL");
    }
  });

  test("opening a finding reveals its AI-generated remediation steps", async ({ page }) => {
    await page.goto("/dashboard/findings");
    const rows = page.getByTestId("finding-row");
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });

    await rows.first().click();
    await expect(page.getByTestId("finding-remediation")).toBeVisible();
    await expect(page.getByTestId("finding-explanation")).toBeVisible();
  });
});
