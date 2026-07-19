import { test, expect } from '@playwright/test';

test.describe('Codename Onboarding Interception', () => {
  test('unauthenticated user trying to access /setup/codename is redirected to login', async ({ page }) => {
    await page.goto('/setup/codename', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/login/);
  });

  test('authenticated user without a codename is redirected to /setup/codename when visiting /dashboard', async ({ page, context }) => {
    // Mock user without a codename using cookie 'nocodename'
    await context.addCookies([
      {
        name: 'mock-session',
        value: 'nocodename',
        domain: 'localhost',
        path: '/',
      },
    ]);

    await page.goto('/dashboard');
    // It should redirect to the codename setup page
    await expect(page).toHaveURL(/\/setup\/codename/);
    await expect(page.getByRole('heading', { name: 'The Naming Ceremony' })).toBeVisible();
  });

  test('authenticated user with a codename trying to access /setup/codename is redirected to /dashboard', async ({ page, context }) => {
    // Mock user with a codename (Rio)
    await context.addCookies([
      {
        name: 'mock-session',
        value: 'user',
        domain: 'localhost',
        path: '/',
      },
    ]);

    await page.goto('/setup/codename');
    // It should redirect to dashboard
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
