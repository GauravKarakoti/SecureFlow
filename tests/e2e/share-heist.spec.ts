import { test, expect } from '@playwright/test';

const BASE = '/share/heist';

test('renders terminal UI with default params', async ({ page }) => {
  await page.goto(BASE);

  // Terminal title bar
  await expect(page.getByText(/SecureFlow \/\/ Heist Audit/i)).toBeVisible();

  // At least one system line from the static transmission
  await expect(page.getByText(/INITIALIZING SECURE CHANNEL/i)).toBeVisible({ timeout: 15_000 });
});

test('reflects query params in the transmission', async ({ page }) => {
  await page.goto(`${BASE}?project=TestVault&alias=Berlin&score=85&rank=A&findingsCount=3`);

  // Data lines derived from query params
  await expect(page.getByText(/TestVault/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/85\/100/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/RANK A/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Findings logged: 3/i)).toBeVisible({ timeout: 15_000 });
});

test('skip decryption button reveals payload immediately', async ({ page }) => {
  await page.goto(`${BASE}?project=SkipTest&score=100`);

  const skip = page.getByRole('button', { name: /skip decryption/i });

  // Skip button is visible while transmission is in progress
  await expect(skip).toBeVisible({ timeout: 10_000 });
  await skip.click();

  // After skip, the payload section (CTA) must be visible
  await expect(page.getByRole('link', { name: /Join the Resistance/i })).toBeVisible();
});

test('Join the Resistance link points to home', async ({ page }) => {
  // Use reduced-motion so the payload is revealed without waiting for the full animation
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${BASE}?project=LinkTest&score=95`);

  const cta = page.getByRole('link', { name: /Join the Resistance/i });
  await expect(cta).toBeVisible({ timeout: 15_000 });
  await expect(cta).toHaveAttribute('href', '/');
});

test('reduced-motion skips animation and shows full transmission', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${BASE}?project=MotionTest&score=72&rank=B`);

  // All key lines must be present without waiting for sequential decode
  await expect(page.getByText(/SENDER: THE PROFESSOR/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/END OF TRANSMISSION/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('link', { name: /Join the Resistance/i })).toBeVisible();
});

test('score below 40 resolves to rank D tagline', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${BASE}?project=LowScore&score=20`);

  await expect(page.getByText(/Blown cover/i)).toBeVisible({ timeout: 10_000 });
});

test('footer branding is present', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.getByText(/#BellaCiao/i)).toBeVisible();
});
