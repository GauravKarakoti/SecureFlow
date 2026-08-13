import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateWebhookSignature, sendWebhook } from './webhook';
import { createHmac } from 'crypto';

describe('Webhook Utilities', () => {
  const secret = 'test-secret';
  const payload = { test: 'data', event: 'scan_completed' };
  const payloadString = JSON.stringify(payload);

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('OK', { status: 200 }))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('generateWebhookSignature', () => {
    it('generates the correct HMAC-SHA256 signature for an object payload', () => {
      const signature = generateWebhookSignature(payload, secret);
      const expectedSignature = createHmac('sha256', secret).update(payloadString).digest('hex');
      
      expect(signature).toBe(expectedSignature);
    });

    it('generates the correct HMAC-SHA256 signature for a string payload', () => {
      const signature = generateWebhookSignature(payloadString, secret);
      const expectedSignature = createHmac('sha256', secret).update(payloadString).digest('hex');
      
      expect(signature).toBe(expectedSignature);
    });
  });

  describe('sendWebhook', () => {
    it('sends the webhook with the correct headers and payload', async () => {
      const url = 'https://example.com/webhook';
      const response = await sendWebhook(url, payload, secret);

      const expectedSignature = generateWebhookSignature(payloadString, secret);

      expect(fetch).toHaveBeenCalledWith(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SecureFlow-Signature': expectedSignature,
        },
        body: payloadString,
      });
      
      expect(response.status).toBe(200);
    });
  });
});
