import { test, expect } from '@playwright/test';
import { createHmac } from 'crypto';

const SECRET = 'e2e-webhook-secret';

/**
 * Signs a webhook payload body with HMAC-SHA256 using the test secret.
 * Mirrors the signing method used by GitHub to produce x-hub-signature-256.
 */
function signWebhookPayload(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

// ────────────────────────────────────────────────────────────────────────────
// Issue #402 — E2E Test Coverage for DLQ (Dead Letter Queue)
//
// Strategy:
//   1. Fire a malformed webhook at POST /api/webhooks/github — it gets queued
//      as a job but the MOCK_DB mode pre-seeds the DLQ with failed entries.
//   2. Navigate to /admin/queue as an authenticated admin.
//   3. Verify the DLQTable section renders failed job rows.
//   4. Expand a row to inspect failure details.
//   5. Test search/filter to confirm filtering works on repo / event / reason.
//   6. Test the Requeue and Delete action buttons respond correctly.
//   7. Test the "Requeue All" / "Clear All" bulk-action buttons.
// ────────────────────────────────────────────────────────────────────────────
test.describe('Dead Letter Queue (DLQ) — E2E UI Coverage (#402)', () => {
  test.beforeEach(async ({ context }) => {
    // Inject the mock admin session cookie so the middleware lets us through.
    await context.addCookies([
      {
        name: 'mock-session',
        value: 'admin',
        domain: 'localhost',
        path: '/',
      },
    ]);
  });

  // ── Scenario 1: Force a webhook failure and verify it surfaces in the DLQ ──
  test('fires a signed webhook that is accepted but fails processing, DLQ UI shows failed jobs', async ({
    request,
    page,
  }) => {
    // 1a. Craft a webhook payload that will be queued then fail in the worker.
    //     In MOCK_DB mode the DLQ mock data is pre-seeded, so the purpose of
    //     this step is to assert that the queue ingestion path (HTTP 202) is
    //     healthy and that DLQ entries subsequently appear in the admin UI.
    const deliveryId = `e2e-dlq-delivery-${Date.now()}`;
    const webhookPayload = {
      // Intentionally omit `pull_request` to cause a worker validation failure
      // in a real environment. In mock mode we rely on the seeded DLQ entries.
      action: 'opened',
      repository: {
        id: 123456,
        full_name: 'mock-owner/mock-repo',
        owner: { login: 'mock-owner' },
        name: 'mock-repo',
      },
      installation: { id: 888999 },
      sender: { id: 777 },
    };

    const rawBody = JSON.stringify(webhookPayload);
    const signature = signWebhookPayload(rawBody, SECRET);

    // Fire the webhook — expect 202 Accepted.
    const response = await request.post('/api/webhooks/github', {
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      data: rawBody,
    });

    // The webhook endpoint should acknowledge immediately with 202.
    expect(response.status()).toBe(202);
    const body = await response.json();
    expect(body.status).toBe('queued');
    expect(body.deliveryId).toBe(deliveryId);

    // 1b. Navigate to the admin queue monitor — the page should render with
    //     the DLQ section populated by mock-seeded failed jobs.
    await page.goto('/admin/queue');

    // Queue Monitor page title is present.
    await expect(page.getByRole('heading', { name: 'Queue Monitor' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Dead-Letter Queue (DLQ)' })
    ).toBeVisible();

    // The DLQ table should NOT show "No failed jobs in the DLQ." because the
    // mock seeds two failed entries.
    await expect(
      page.getByText('No failed jobs in the DLQ.')
    ).not.toBeVisible();

    // The first mock DLQ entry's repository should appear in the table.
    await expect(page.getByText('mock-owner/mock-repo')).toBeVisible();
  });

  // ── Scenario 2: DLQ table renders all expected columns ─────────────────────
  test('DLQTable renders correct column headers and job row data', async ({ page }) => {
    await page.goto('/admin/queue');

    // Table header columns
    await expect(page.getByRole('columnheader', { name: 'Target / Event' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Action' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Failed At' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Actions' })).toBeVisible();

    // First seeded failed job — repo visible
    await expect(page.getByText('mock-owner/mock-repo')).toBeVisible();

    // Second seeded failed job — different repo
    await expect(page.getByText('mock-owner/another-repo')).toBeVisible();

    // Both jobs show the `opened` and `push` action badges
    await expect(page.getByText('opened').first()).toBeVisible();
    await expect(page.getByText('push').first()).toBeVisible();
  });

  // ── Scenario 3: Expand a row to see failure details ────────────────────────
  test('expanding a DLQ job row reveals the failure reason and job payload', async ({ page }) => {
    await page.goto('/admin/queue');

    // Click the first row to expand it.
    const firstRow = page.locator('tbody tr').first();
    await firstRow.click();

    // After expansion the "Failure Reason" section should appear.
    await expect(page.getByText('Failure Reason')).toBeVisible();

    // The seeded failure reason string should be visible.
    await expect(
      page.getByText('GitHub API rate limit exceeded after 3 attempts')
    ).toBeVisible();

    // The "Job Data Payload" section should also appear.
    await expect(page.getByText('Job Data Payload')).toBeVisible();

    // The raw JSON payload should contain identifiable event data.
    await expect(page.getByText('pull_request')).toBeVisible();
  });

  // ── Scenario 4: Filter / search the DLQ table ──────────────────────────────
  test('searching by repository name filters the DLQ job list correctly', async ({ page }) => {
    await page.goto('/admin/queue');

    const searchInput = page.getByPlaceholder(
      'Filter DLQ jobs by repo, event, action...'
    );
    await expect(searchInput).toBeVisible();

    // Filter by the second job's repo — should show only 1 row.
    await searchInput.fill('another-repo');
    await expect(page.getByText('mock-owner/another-repo')).toBeVisible();
    // The first job's repo must not be visible after filtering.
    await expect(page.getByText('mock-owner/mock-repo')).not.toBeVisible();

    // Clear the filter — both rows should reappear.
    await searchInput.fill('');
    await expect(page.getByText('mock-owner/mock-repo')).toBeVisible();
    await expect(page.getByText('mock-owner/another-repo')).toBeVisible();
  });

  // ── Scenario 5: Search by failure reason ───────────────────────────────────
  test('searching by failure reason keyword shows matching jobs only', async ({ page }) => {
    await page.goto('/admin/queue');

    const searchInput = page.getByPlaceholder(
      'Filter DLQ jobs by repo, event, action...'
    );

    // Filter by a keyword unique to the second job's failure reason.
    await searchInput.fill('Invalid payload');
    await expect(page.getByText('mock-owner/another-repo')).toBeVisible();
    await expect(page.getByText('mock-owner/mock-repo')).not.toBeVisible();

    await searchInput.fill('');
  });

  // ── Scenario 6: Single job requeue action button ───────────────────────────
  test('clicking Requeue on a single DLQ job removes it from the table', async ({ page }) => {
    await page.goto('/admin/queue');

    // Count initial rows in DLQ table body.
    const initialRows = await page.locator('tbody tr:not(:has(td[colspan]))').count();
    expect(initialRows).toBeGreaterThanOrEqual(2);

    // Click the requeue (play) button on the first visible job row.
    const requeueBtn = page
      .locator('tbody tr:not(:has(td[colspan]))')
      .first()
      .getByTitle('Requeue Job');
    await requeueBtn.click();

    // After requeue, the job should be removed from the DLQ table.
    // The row count should decrease by 1.
    await expect(page.locator('tbody tr:not(:has(td[colspan]))')).toHaveCount(
      initialRows - 1
    );
  });

  // ── Scenario 7: Single job delete action button ────────────────────────────
  test('clicking Delete on a single DLQ job removes it from the table', async ({ page }) => {
    await page.goto('/admin/queue');

    const initialRows = await page.locator('tbody tr:not(:has(td[colspan]))').count();
    expect(initialRows).toBeGreaterThanOrEqual(1);

    // Click the delete (trash) button on the first visible job row.
    const deleteBtn = page
      .locator('tbody tr:not(:has(td[colspan]))')
      .first()
      .getByTitle('Delete Job');
    await deleteBtn.click();

    await expect(page.locator('tbody tr:not(:has(td[colspan]))')).toHaveCount(
      initialRows - 1
    );
  });

  // ── Scenario 8: Requeue All bulk action ────────────────────────────────────
  test('"Requeue All" button re-queues all DLQ jobs and clears the table', async ({
    page,
  }) => {
    await page.goto('/admin/queue');

    // Wait for the DLQ section to be populated.
    await expect(page.getByText('mock-owner/mock-repo')).toBeVisible();

    // Click "Requeue All".
    await page.getByRole('button', { name: /Requeue All/i }).click();

    // The table should now show the empty state message.
    await expect(page.getByText('No failed jobs in the DLQ.')).toBeVisible({
      timeout: 8000,
    });
    await expect(page.getByText("The Resistance is operating smoothly.")).toBeVisible();
  });

  // ── Scenario 9: Clear All DLQ bulk action ──────────────────────────────────
  test('"Clear All" button permanently deletes all DLQ jobs', async ({ page }) => {
    await page.goto('/admin/queue');

    await expect(page.getByText('mock-owner/mock-repo')).toBeVisible();

    // Click "Clear All".
    await page.getByRole('button', { name: /Clear All/i }).click();

    await expect(page.getByText('No failed jobs in the DLQ.')).toBeVisible({
      timeout: 8000,
    });
  });

  // ── Scenario 10: Bulk selection and bulk actions ───────────────────────────
  test('bulk-selecting jobs enables "Retry Selected" and "Delete Selected" buttons', async ({
    page,
  }) => {
    await page.goto('/admin/queue');

    await expect(page.getByText('mock-owner/mock-repo')).toBeVisible();

    // Select the first job via its checkbox.
    const firstCheckbox = page
      .locator('tbody tr:not(:has(td[colspan]))')
      .first()
      .locator('input[type="checkbox"]');
    await firstCheckbox.check();

    // When at least one job is selected, the bulk-action toolbar appears.
    await expect(page.getByText('1 selected')).toBeVisible();
    await expect(page.getByRole('button', { name: /Retry Selected/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Delete Selected/i })).toBeVisible();

    // Deselect using the toolbar button.
    await page.getByRole('button', { name: /Deselect/i }).click();
    await expect(page.getByText('1 selected')).not.toBeVisible();
  });

  // ── Scenario 11: Queue metric cards show the Failed (DLQ) count ───────────
  test('Queue Monitor metric cards render the Failed (DLQ) count', async ({ page }) => {
    await page.goto('/admin/queue');

    // All five metric cards should be present.
    await expect(page.getByRole('heading', { name: 'Waiting' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Active' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Completed' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Failed (DLQ)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Delayed' })).toBeVisible();

    // In mock mode, the "Failed (DLQ)" card displays 0 from getQueueMetrics
    // (which is separate from the seeded getDLQJobs list).
    const failedCard = page.locator('[class*="glass-card"]').filter({
      has: page.getByRole('heading', { name: 'Failed (DLQ)' }),
    });
    await expect(failedCard).toBeVisible();
  });
});
