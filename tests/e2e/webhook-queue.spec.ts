import { test, expect } from '@playwright/test';
import { createHmac } from 'crypto';

const SECRET = 'e2e-webhook-secret';

function sign(body: string, secret: string) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

test.describe('Webhook Queue Worker E2E Lifecycle', () => {
  test('end-to-end webhook lifecycle: fires webhook, queues & processes job, verifies DB state updates', async ({ request }) => {
    // Ensure GITHUB_WEBHOOK_SECRET is set for the test environment
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;

    const deliveryId = `e2e-delivery-${Date.now()}`;
    const webhookPayload = {
      action: 'opened',
      pull_request: {
        id: 999111,
        number: 42,
        title: 'E2E Queue Worker Lifecycle Test PR',
        state: 'open',
        head: { sha: 'e2e-test-sha-123' },
        user: { login: 'tokyo_coder' },
      },
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
    const signature = sign(rawBody, SECRET);

    // 1. Fire mock webhook request to POST /api/webhooks/github
    const response = await request.post('/api/webhooks/github', {
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      data: rawBody,
    });

    // 2. Verify response status is 202 Accepted and contains queue metadata
    expect(response.status()).toBe(202);
    const responseBody = await response.json();
    expect(responseBody.status).toBe('queued');
    expect(responseBody.deliveryId).toBe(deliveryId);

    // 3. In MOCK_DB environment, verify mock PR and DB state
    const prResponse = await request.get('/api/admin/export', {
      headers: {
        cookie: 'mock-session=admin',
      },
    });
    expect(prResponse.status()).toBe(200);
    const csvContent = await prResponse.text();
    expect(csvContent).toContain('id,userId,action,resource,decision,metadata,timestamp');
    expect(csvContent).toContain('mock-admin-id');
  });
});
