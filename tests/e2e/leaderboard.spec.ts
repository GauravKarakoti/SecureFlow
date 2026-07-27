import { test, expect } from '@playwright/test';

test('leaderboard page renders public leaderboard', async ({ page }) => {
  await page.goto('/leaderboard');

  await expect(page.getByRole('heading', { name: /Most Wanted/i })).toBeVisible();
  await expect(page.getByText(/extraction \(Merged PR\)/i)).toBeVisible();

  // Either the crew table or the empty-state message must be present.
  const empty = page.getByText(/No operatives yet/i);
  const rows = page.locator('tbody tr');

  if (await empty.count()) {
    await expect(empty.first()).toBeVisible();
  } else {
    await expect(rows.first()).toBeVisible();
  }
});
