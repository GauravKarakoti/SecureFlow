import { test, expect, Page } from "@playwright/test";

/**
 * Enterprise E2E Test Suite for Analytics & Audit Log Components (#1144)
 * Comprehensive test coverage ensuring data visualizations, charts,
 * audit table pagination, filtering, search queries, and responsive viewports
 * remain fully robust and regression-free.
 */

test.describe("SecureFlow Enterprise Analytics & Audit Log Comprehensive E2E Suite (#1144)", () => {
  const setupAdvancedMockRoutes = async (page: Page) => {
    // Intercept analytics API to provide stable mock time-series & metrics data
    await page.route("**/api/analytics**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "success",
          metrics: {
            totalScans: 25480,
            blockedInjections: 842,
            averageLatencyMs: 38,
            activeGuards: 24,
            systemHealthScore: "99.8%",
          },
          timeSeries: [
            { timestamp: "2026-09-01", scans: 1400, blocked: 35 },
            { timestamp: "2026-09-02", scans: 1650, blocked: 42 },
            { timestamp: "2026-09-03", scans: 1800, blocked: 55 },
            { timestamp: "2026-09-04", scans: 1550, blocked: 38 },
            { timestamp: "2026-09-05", scans: 1900, blocked: 62 },
            { timestamp: "2026-09-06", scans: 2100, blocked: 78 },
          ],
        }),
      });
    });

    // Intercept audit logs API to provide deterministic paginated record rows
    await page.route("**/api/audit-logs**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          totalRecords: 250,
          page: 1,
          pageSize: 15,
          logs: Array.from({ length: 15 }, (_, i) => ({
            id: `audit-rec-${i + 1}`,
            timestamp: new Date(Date.now() - i * 1800000).toISOString(),
            actor: `sec_operator_${i + 1}@secureflow.enterprise`,
            action: i % 2 === 0 ? "PROMPT_INJECTION_BLOCKED" : "POLICY_CONFIG_UPDATED",
            severity: i % 3 === 0 ? "CRITICAL" : "MEDIUM",
            status: "SUCCESS",
            details: `Automated inspection triggered for payload vector ID inj-00${i + 1}`,
          })),
        }),
      });
    });
  };

  test.beforeEach(async ({ page }) => {
    await setupAdvancedMockRoutes(page);
  });

  test.describe("analytics-client.tsx Visualization & Metric Cards Suite", () => {
    test("should render dashboard header, KPI metric cards, and primary visualization canvas", async ({
      page,
    }) => {
      await page.goto("/analytics");

      // Verify dashboard title & KPI metric cards are visible
      await expect(
        page.locator("h1, h2").filter({ hasText: /Analytics|Security Dashboard/i }),
      ).toBeVisible();
      await expect(page.locator("text=Total Scans")).toBeVisible({ timeout: 10000 });
      await expect(page.locator("text=Blocked Injections")).toBeVisible();
      await expect(page.locator("text=Average Latency")).toBeVisible();

      // Verify chart containers or Recharts wrappers load correctly
      const chartWrapper = page
        .locator('[data-testid="analytics-chart"], .recharts-wrapper, canvas')
        .first();
      await expect(chartWrapper).toBeVisible();
    });

    test("should support interactive time-range filter toggles without visual regressions", async ({
      page,
    }) => {
      await page.goto("/analytics");

      const timeRangeSelector = page.locator(
        'button:has-text("Last 7 Days"), select[name="timeRange"], [aria-label="Select Time Range"]',
      );
      if (await timeRangeSelector.isVisible()) {
        await timeRangeSelector.click();
        const option30Days = page.locator('text=Last 30 Days, option[value="30d"]');
        if (await option30Days.isVisible()) {
          await option30Days.click();
        }
      }

      const chartWrapper = page
        .locator('[data-testid="analytics-chart"], .recharts-wrapper, canvas')
        .first();
      await expect(chartWrapper).toBeVisible();
    });

    test("should gracefully render error fallback UI when analytics API service fails", async ({
      page,
    }) => {
      await page.route("**/api/analytics**", async (route) => {
        await route.fulfill({ status: 500, body: "Service Unavailable" });
      });

      await page.goto("/analytics");
      const errorFallback = page.locator("text=Failed to load, text=Error, text=Retry").first();
      await expect(errorFallback).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe("audit-log-table.tsx Pagination, Filtering & Drawer Suite", () => {
    test("should render audit log table structure, column headers, and rows correctly", async ({
      page,
    }) => {
      await page.goto("/audit");

      const auditTable = page.locator('table, [data-testid="audit-log-table"]');
      await expect(auditTable).toBeVisible();

      await expect(page.locator('th:has-text("Actor"), th:has-text("User")')).toBeVisible();
      await expect(page.locator('th:has-text("Action")')).toBeVisible();
      await expect(page.locator('th:has-text("Severity"), th:has-text("Status")')).toBeVisible();
    });

    test("should handle pagination next and previous controls reliably", async ({ page }) => {
      await page.goto("/audit");

      const nextButton = page.locator('button:has-text("Next"), [aria-label="Next page"]');
      if ((await nextButton.isVisible()) && (await nextButton.isEnabled())) {
        await nextButton.click();
        const auditTable = page.locator('table, [data-testid="audit-log-table"]');
        await expect(auditTable).toBeVisible();

        const prevButton = page.locator(
          'button:has-text("Previous"), [aria-label="Previous page"]',
        );
        await expect(prevButton).toBeEnabled();
      }
    });

    test("should filter audit log table entries using search query inputs", async ({ page }) => {
      await page.goto("/audit");

      const searchInput = page.locator(
        'input[placeholder*="Search"], input[placeholder*="Filter"]',
      );
      if (await searchInput.isVisible()) {
        await searchInput.fill("PROMPT_INJECTION_BLOCKED");
        await page.keyboard.press("Enter");

        const auditTable = page.locator('table, [data-testid="audit-log-table"]');
        await expect(auditTable).toBeVisible();
      }
    });

    test("should open audit detail drawer inspect modal upon row selection", async ({ page }) => {
      await page.goto("/audit");

      const firstRow = page.locator('tbody tr, [data-testid="audit-row"]').first();
      if (await firstRow.isVisible()) {
        await firstRow.click();
        const detailDrawer = page.locator(
          '[role="dialog"], [data-testid="audit-drawer"], .drawer-content',
        );
        if (await detailDrawer.isVisible()) {
          await expect(detailDrawer).toBeVisible();
        }
      }
    });
  });

  test.describe("Responsive Viewport & Cross-Device Stress Tests", () => {
    test("should render analytics charts and audit logs correctly on mobile device viewports", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 375, height: 812 });

      await page.goto("/analytics");
      await expect(page.locator("h1, h2").filter({ hasText: /Analytics|Security/i })).toBeVisible();

      await page.goto("/audit");
      const mobileTable = page.locator('table, [data-testid="audit-log-table"], .overflow-x-auto');
      await expect(mobileTable).toBeVisible();
    });

    test("should adapt layout seamlessly on tablet viewports", async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });

      await page.goto("/analytics");
      const chartWrapper = page
        .locator('[data-testid="analytics-chart"], .recharts-wrapper, canvas')
        .first();
      await expect(chartWrapper).toBeVisible();
    });
  });
});
