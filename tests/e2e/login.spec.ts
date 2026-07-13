import { test, expect } from '@playwright/test';

test('login page renders and starts GitHub sign-in', async ({ page }) => {
  await page.goto('/login');

  await expect(page.getByRole('heading', { name: 'Welcome!!' })).toBeVisible();

  // Button text comes from the server component.
  const cta = page.getByRole('button', { name: /Continue with GitHub/i });
  await expect(cta).toBeVisible();

  await cta.click();

  // Auth.js redirects into its own flow. We assert we leave the login route.
  await expect(page).not.toHaveURL(/\/login/);

  // Auth.js typically routes into its own sign-in/authorize endpoints.
  await expect(page.url()).toMatch(/api\/auth|callback|github/i);
});

