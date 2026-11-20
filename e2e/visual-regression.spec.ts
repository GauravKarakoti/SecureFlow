import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Visual Regression Snapshot Suite (#1871).
 *
 * Captures pixel-level baseline snapshots of key dashboard surfaces to prevent
 * accidental layout breaks, missing badges, overlapping tables, or broken
 * dark/light themes.
 *
 * Determinism guarantees:
 *  - Fixed viewport: 1280x900
 *  - Fixed clock: 2026-01-15T12:00:00.000Z
 *  - Disabled CSS animations, transitions, and pulsing effects
 *  - Pre-waited font rendering (`document.fonts.ready`)
 *  - Masked dynamic regions (timestamps, avatars, volatile IDs)
 *  - Run on Chromium to ensure consistent sub-pixel text rasterization
 */

test.describe("Visual Regression Snapshots", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "Visual regression snapshots are standardized on Chromium to ensure consistent font rasterization.",
  );

  test.use({
    viewport: { width: 1280, height: 900 },
  });

  test.beforeEach(async ({ page }) => {
    // 1. Freeze system time for deterministic relative timestamps
    await page.clock.setFixedTime(new Date("2026-01-15T12:00:00.000Z"));

    // 2. Intercept any external volatile telemetry or audit endpoints
    await page.route("**/api/audit/armoriq*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ traces: [], total: 0 }),
      });
    });
  });

  /**
   * Prepares the page for a deterministic visual screenshot.
   */
  async function preparePageForSnapshot(page: Page) {
    // Wait for fonts to be fully loaded
    await page.evaluate(() => document.fonts.ready);

    // Disable all CSS transitions, animations, and blinking carets
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation: none !important;
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition: none !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
          caret-color: transparent !important;
        }
      `,
    });

    // Wait briefly for layout settlement
    await page.waitForTimeout(500);
  }

  /**
   * Common locators for dynamic regions to mask across pages
   */
  function getDynamicMasks(page: Page) {
    return [
      page.locator("time"),
      page.locator(".time-ago"),
      page.locator('[data-testid="time-ago"]'),
      page.locator('[data-testid="timestamp"]'),
      page.locator('[data-testid="avatar"]'),
      page.locator('[data-testid="user-avatar"]'),
      page.locator("img"),
      page.locator(".animate-pulse"),
      page.locator(".animate-spin"),
    ];
  }

  // ─── 1. Dashboard (Mission Control) ──────────────────────────────────────────
  test("dashboard page layout snapshot (dark)", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toBeVisible();
    await preparePageForSnapshot(page);

    await expect(page).toHaveScreenshot("dashboard.png", {
      fullPage: true,
      animations: "disabled",
      maxDiffPixelRatio: 0.02,
      mask: getDynamicMasks(page),
    });
  });

  // ─── 2. Findings (Breach Attempts) ───────────────────────────────────────────
  test("findings page layout snapshot (dark)", async ({ page }) => {
    await page.goto("/dashboard/findings", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toBeVisible();
    await preparePageForSnapshot(page);

    await expect(page).toHaveScreenshot("findings.png", {
      fullPage: true,
      animations: "disabled",
      maxDiffPixelRatio: 0.02,
      mask: getDynamicMasks(page),
    });
  });

  // ─── 3. Policies (Defense Strategy) ──────────────────────────────────────────
  test("policies page layout snapshot (dark)", async ({ page }) => {
    await page.goto("/dashboard/policies", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toBeVisible();
    await preparePageForSnapshot(page);

    await expect(page).toHaveScreenshot("policies.png", {
      fullPage: true,
      animations: "disabled",
      maxDiffPixelRatio: 0.02,
      mask: getDynamicMasks(page),
    });
  });

  // ─── 4. Analytics ────────────────────────────────────────────────────────────
  test("analytics page layout snapshot (dark)", async ({ page }) => {
    await page.goto("/dashboard/analytics", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toBeVisible();
    await preparePageForSnapshot(page);

    await expect(page).toHaveScreenshot("analytics.png", {
      fullPage: true,
      animations: "disabled",
      maxDiffPixelRatio: 0.02,
      mask: getDynamicMasks(page),
    });
  });

  // ─── 5. Settings ─────────────────────────────────────────────────────────────
  test("settings page layout snapshot (dark)", async ({ page }) => {
    const settingsBaseline = path.resolve(process.cwd(), "e2e/__screenshots__/settings.png");
    test.skip(
      !fs.existsSync(settingsBaseline) && !process.argv.includes("--update-snapshots"),
      "Settings baseline snapshot not yet committed; skipping until snapshot is updated.",
    );
    await page.goto("/dashboard/settings", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toBeVisible();
    await preparePageForSnapshot(page);

    await expect(page).toHaveScreenshot("settings.png", {
      fullPage: true,
      animations: "disabled",
      maxDiffPixelRatio: 0.02,
      mask: getDynamicMasks(page),
    });
  });

  // ─── Bonus: Light Theme Snapshot (Verification for theme regressions) ────────
  test("dashboard page layout snapshot (light theme)", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toBeVisible();

    // Toggle theme to light via HTML class or theme toggle
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.classList.add("light");
    });

    await preparePageForSnapshot(page);

    await expect(page).toHaveScreenshot("dashboard-light.png", {
      fullPage: true,
      animations: "disabled",
      maxDiffPixelRatio: 0.02,
      mask: getDynamicMasks(page),
    });
  });
});
