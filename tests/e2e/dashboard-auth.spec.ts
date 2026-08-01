import { test, expect } from '@playwright/test';

test('dashboard unauthenticated redirects to sign-in', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  // The server route redirects to /login when no session.
  await expect(page).toHaveURL(/\/login/i);

  // NextAuth UI typically renders some sign-in content.
  await expect(page.locator('body')).toBeVisible();
});

