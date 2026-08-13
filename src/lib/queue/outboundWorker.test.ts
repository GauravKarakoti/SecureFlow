import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { outboundWorker } from './outboundWorker';
import { Job } from 'bullmq';

describe('Outbound Webhook Worker', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('OK', { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('successfully dispatches a webhook without a secret', async () => {
    const job = {
      id: 'job-1',
      data: {
        url: 'https://example.com/hook',
        payload: { event: 'test' },
      },
    } as unknown as Job;

    await (outboundWorker as any).processFn(job);

    expect(fetch).toHaveBeenCalledWith('https://example.com/hook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event: 'test' }),
    });
  });

  it('successfully dispatches a webhook with a secret (HMAC)', async () => {
    const job = {
      id: 'job-2',
      data: {
        url: 'https://example.com/hook-secure',
        payload: { event: 'secure-test' },
        secret: 'test-secret',
      },
    } as unknown as Job;

    await (outboundWorker as any).processFn(job);

    expect(fetch).toHaveBeenCalledWith('https://example.com/hook-secure', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SecureFlow-Signature': expect.any(String),
      },
      body: JSON.stringify({ event: 'secure-test' }),
    });
  });

  it('throws an error if fetch fails (to trigger BullMQ retries)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('Error', { status: 500, statusText: 'Internal Server Error' }));

    const job = {
      id: 'job-3',
      data: {
        url: 'https://example.com/fail',
        payload: { event: 'fail-test' },
      },
    } as unknown as Job;

    await expect((outboundWorker as any).processFn(job)).rejects.toThrow('Failed to dispatch webhook. HTTP Status: 500 Internal Server Error');
  });
});
