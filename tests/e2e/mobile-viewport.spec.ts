import { test, expect } from '@playwright/test';

test.describe('Mobile Viewport E2E Tests', () => {
  test('renders login page correctly on mobile viewports without horizontal overflow', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveTitle(/SecureFlow/i);

    const body = page.locator('body');
    await expect(body).toBeVisible();

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth).toBeLessThanOrEqual(viewportWidth);
  });

  test('heist transmission view adapts to mobile screen bounds', async ({ page }) => {
    await page.goto('/share/heist');

    const container = page.locator('main');
    await expect(container).toBeVisible();

    const isMobile = await page.evaluate(() => window.innerWidth < 768);
    if (isMobile) {
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const viewportWidth = await page.evaluate(() => window.innerWidth);
      expect(scrollWidth).toBeLessThanOrEqual(viewportWidth);
    }
  });
});
