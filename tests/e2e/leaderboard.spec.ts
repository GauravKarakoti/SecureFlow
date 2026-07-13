import { test, expect } from '@playwright/test';

test('leaderboard page renders public leaderboard', async ({ page }) => {
  await page.goto('/leaderboard');

  await expect(page.getByRole('heading', { name: /Most Wanted/i })).toBeVisible();
  await expect(page.getByText(/1 Star = 1 PR Merged/i)).toBeVisible();

  // Either podium cards or empty-state message are acceptable.
  const crewTable = page.getByRole('table').or(page.locator('table'));
  await expect(crewTable.first()).toBeVisible();

  // If empty, a helper message exists; otherwise, table has rows.
  const empty = page.getByText(/No contributors yet|No contributors/i);
  const rows = page.locator('tbody tr');
  if (await empty.count()) {
    await expect(empty.first()).toBeVisible();
  } else {
    await expect(rows.first()).toBeVisible();
  }
});

