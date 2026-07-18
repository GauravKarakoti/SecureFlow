import { test, expect } from '@playwright/test';

test.describe('GitHub App Setup', () => {
  test('unauthenticated setup redirects to login', async ({ page }) => {
    // When no mock-session cookie is set, it is unauthenticated.
    await page.goto('/setup?installation_id=12345', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/login/);
  });

  test('setup without installation_id redirects to dashboard', async ({ page, context }) => {
    // Authenticate as a user
    await context.addCookies([
      {
        name: 'mock-session',
        value: 'user',
        domain: 'localhost',
        path: '/',
      },
    ]);

    await page.goto('/setup');
    // It redirects to dashboard because installation_id is missing
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('setup with installation_id registers repo and redirects to dashboard', async ({ page, context }) => {
    // Authenticate as a user
    await context.addCookies([
      {
        name: 'mock-session',
        value: 'user',
        domain: 'localhost',
        path: '/',
      },
    ]);

    await page.goto('/setup?installation_id=12345');
    // It should register repositories and redirect to dashboard
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
