import { test, expect } from "@playwright/test";

test.describe("Findings dashboard", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      {
        name: "mock-session",
        value: "user",
        domain: "localhost",
        path: "/",
      },
    ]);
  });

  test("renders security findings and SBOM report", async ({ page }) => {
    await page.goto("/dashboard/findings", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByText("Security Findings")).toBeVisible();
    await expect(page.getByText("SECRET Detected")).toBeVisible();
    await expect(page.getByText("VULNERABILITY Detected")).toBeVisible();

    await expect(page.getByText("SBOM Dependency Scan")).toBeVisible();
    await expect(page.getByText("VULNERABLE")).toBeVisible();
  });

  test("displays triage controls for a finding", async ({ page }) => {
    await page.goto("/dashboard/findings", {
      waitUntil: "domcontentloaded",
    });

    await page.getByRole("button", { name: /SECRET Detected/ }).click();

    await expect(page.getByRole("heading", { name: "Triage" })).toBeVisible();
  });

  test("opens bulk triage confirmation dialog", async ({ page }) => {
    await page.goto("/dashboard/findings", {
      waitUntil: "domcontentloaded",
    });

    await page.getByTestId("findings-toolbar").getByRole("button", { name: "Bulk select" }).click();

    await expect(page.getByRole("button", { name: "Cancel bulk select" })).toBeVisible();

    const checkboxes = page.locator('[aria-label="Select all findings on this page"]');
    await expect(checkboxes.first()).toBeVisible();

    await checkboxes.last().check();

    await expect(page.getByText("Bulk triage")).toBeVisible();

    await page.getByRole("button", { name: "Dismiss all" }).click();

    await expect(page.getByText("Apply bulk triage?")).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm" })).toBeVisible();
  });
});
