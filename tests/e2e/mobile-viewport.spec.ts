import { test, expect } from "../../e2e/fixtures";

test.describe("Mobile Viewport E2E Tests", () => {
  test.use({ viewport: { width: 360, height: 640 } });

  test("renders login page correctly on mobile viewports without horizontal overflow", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(page).toHaveTitle(/SecureFlow/i);

    const body = page.locator("body");
    await expect(body).toBeVisible();

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth).toBeLessThanOrEqual(viewportWidth);
  });

  test("heist transmission view adapts to mobile screen bounds", async ({ page }) => {
    await page.goto("/share/heist");

    const container = page.locator("main");
    await expect(container).toBeVisible();

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth).toBeLessThanOrEqual(viewportWidth);
  });

  test("Findings page has no horizontal overflow at 360px and finding can be triaged", async ({
    page,
  }) => {
    await page.goto("/dashboard/findings");
    await page.waitForLoadState("domcontentloaded");

    // Check no horizontal page overflow
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth).toBeLessThanOrEqual(viewportWidth);

    // Verify findings table exists
    const findingsTable = page.getByTestId("findings-table");
    const emptyState = page.getByText(/No Security Findings|No findings match/i);
    const hasTable = await findingsTable.isVisible().catch(() => false);

    if (hasTable) {
      const rows = page.getByTestId("finding-row");
      const rowCount = await rows.count();
      if (rowCount > 0) {
        const firstRow = rows.first();
        await expect(firstRow).toBeVisible();

        // Stacked card info visible on mobile
        const severity = firstRow.getByTestId("finding-severity");
        await expect(severity.first()).toBeVisible();

        const file = firstRow.getByTestId("finding-file");
        await expect(file.first()).toBeVisible();

        // Open the accordion
        await firstRow.click();

        // Verify triage controls are visible
        const statusSelect = firstRow.getByTestId("triage-status-select");
        if (await statusSelect.isVisible().catch(() => false)) {
          const selectBox = await statusSelect.boundingBox();
          if (selectBox) {
            expect(selectBox.height).toBeGreaterThanOrEqual(44);
          }
        }

        const saveButton = firstRow.getByTestId("save-triage-button");
        if (await saveButton.isVisible().catch(() => false)) {
          const btnBox = await saveButton.boundingBox();
          if (btnBox) {
            expect(btnBox.height).toBeGreaterThanOrEqual(44);
          }
        }
      }
    } else {
      await expect(emptyState).toBeVisible();
    }
  });

  test("Policies page has no horizontal overflow at 360px and controls meet 44px touch targets", async ({
    page,
  }) => {
    await page.goto("/dashboard/policies");
    await page.waitForLoadState("domcontentloaded");

    // Verify main header
    await expect(page.getByRole("heading", { name: "The Rules" })).toBeVisible({ timeout: 15_000 });

    // Check no horizontal page overflow
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth).toBeLessThanOrEqual(viewportWidth);

    // Check policy cards and touch targets
    const editButtons = page.locator("button[data-testid^='edit-policy-']");
    if ((await editButtons.count()) > 0) {
      const firstEdit = editButtons.first();
      await expect(firstEdit).toBeVisible();
      const editBox = await firstEdit.boundingBox();
      if (editBox) {
        expect(editBox.height).toBeGreaterThanOrEqual(44);
        expect(editBox.width).toBeGreaterThanOrEqual(44);
      }
    }

    const historyButtons = page.locator("button[data-testid^='history-policy-']");
    if ((await historyButtons.count()) > 0) {
      const firstHistory = historyButtons.first();
      await expect(firstHistory).toBeVisible();
      const histBox = await firstHistory.boundingBox();
      if (histBox) {
        expect(histBox.height).toBeGreaterThanOrEqual(44);
        expect(histBox.width).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test("Audit page has no horizontal overflow at 360px and renders stacked card layout", async ({
    page,
  }) => {
    await page.goto("/dashboard/audit");
    await page.waitForLoadState("domcontentloaded");

    // Check no horizontal page overflow
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth).toBeLessThanOrEqual(viewportWidth);

    // Verify stacked cards container is visible on mobile (< md)
    const cardsContainer = page.getByTestId("audit-log-cards");
    await expect(cardsContainer).toBeVisible();

    // Verify pagination button touch targets
    const prevButton = page.getByRole("button", { name: /previous page/i });
    if (await prevButton.isVisible().catch(() => false)) {
      const prevBox = await prevButton.boundingBox();
      if (prevBox) {
        expect(prevBox.height).toBeGreaterThanOrEqual(44);
        expect(prevBox.width).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test("Analytics page has no horizontal overflow at 360px and comparison table has scroll hint", async ({
    page,
  }) => {
    await page.goto("/dashboard/analytics");
    await page.waitForLoadState("domcontentloaded");

    // Check no horizontal page overflow
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth).toBeLessThanOrEqual(viewportWidth);

    // Verify scroll hint or table container if repo data exists
    const tableContainer = page.getByTestId("analytics-table-container");
    const emptyState = page.getByText(/No Repositories/i);
    const hasTable = await tableContainer.isVisible().catch(() => false);

    if (hasTable) {
      const scrollHint = page.getByTestId("analytics-table-scroll-hint");
      await expect(scrollHint).toBeVisible();
    } else {
      await expect(emptyState).toBeVisible();
    }
  });
});
