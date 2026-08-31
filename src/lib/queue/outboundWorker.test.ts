import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Job, UnrecoverableError } from 'bullmq';
import { processOutboundWebhook } from './outboundWorker';
import { SIGNATURE_HEADER, DELIVERY_HEADER, verifySignatureHeader } from './outbound-dispatch';

/**
 * These exercise the real dispatch path with a stubbed `fetch`, so the
 * destination checks, the redirect policy and the retry classification are all
 * live rather than mocked away.
 *
 * `assertDispatchableUrl` short-circuits before DNS for literal addresses, so
 * the hosts below are literals and the suite never touches a resolver.
 */
function makeJob(data: Record<string, unknown>, overrides: Record<string, unknown> = {}): Job<any> {
  return {
    id: 'job-1',
    attemptsMade: 0,
    opts: { attempts: 3 },
    data,
    ...overrides,
  } as unknown as Job<any>;
}

describe('processOutboundWebhook', () => {
  beforeEach(() => {
    // Private destinations are permitted here so the suite can dispatch at a
    // literal address without a DNS round trip. The refusal path is covered
    // explicitly further down with the guard switched back on.
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OUTBOUND_WEBHOOK_ALLOW_PRIVATE_NETWORKS', 'true');
    vi.stubEnv('OUTBOUND_WEBHOOK_ALLOW_INSECURE_HTTP', 'true');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('OK', { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('dispatches a payload without a secret', async () => {
    await processOutboundWebhook(
      makeJob({ url: 'http://10.1.2.3/hook', payload: { event: 'test' } })
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, any];

    expect(url).toBe('http://10.1.2.3/hook');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ event: 'test' }));
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers[SIGNATURE_HEADER]).toBeUndefined();
  });

  it('signs the payload when the job carries a secret', async () => {
    await processOutboundWebhook(
      makeJob({ url: 'http://10.1.2.3/hook', payload: { event: 'secure' }, secret: 'test-secret' })
    );

    const init = vi.mocked(fetch).mock.calls[0][1] as any;
    const signature = init.headers[SIGNATURE_HEADER];

    expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(
      verifySignatureHeader(signature, 'test-secret', JSON.stringify({ event: 'secure' }))
    ).toBe(true);
  });

  it('throws a retryable error on a 5xx so BullMQ retries', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('Error', { status: 500 }));

    const error = await processOutboundWebhook(
      makeJob({ url: 'http://10.1.2.3/hook', payload: {} })
    ).catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(error.message).toContain('HTTP 500');
  });

  it('throws UnrecoverableError on a 4xx so the job stops retrying immediately', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

    // Three attempts against an endpoint that answered 400 is three attempts
    // wasted; the job should reach the DLQ on the first pass instead.
    await expect(
      processOutboundWebhook(makeJob({ url: 'http://10.1.2.3/hook', payload: {} }))
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('keeps a 429 retryable', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('Slow down', { status: 429 }));

    const error = await processOutboundWebhook(
      makeJob({ url: 'http://10.1.2.3/hook', payload: {} })
    ).catch((err) => err);

    expect(error).not.toBeInstanceOf(UnrecoverableError);
  });

  it('does not follow a redirect', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } })
    );

    await expect(
      processOutboundWebhook(makeJob({ url: 'http://10.1.2.3/hook', payload: {} }))
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses an internal destination without dispatching when the guard is on', async () => {
    vi.stubEnv('OUTBOUND_WEBHOOK_ALLOW_PRIVATE_NETWORKS', 'false');
    vi.stubEnv('OUTBOUND_WEBHOOK_ALLOW_INSECURE_HTTP', 'false');

    await expect(
      processOutboundWebhook(
        makeJob({ url: 'https://169.254.169.254/latest/meta-data/', payload: {} })
      )
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a non-http scheme without dispatching', async () => {
    await expect(
      processOutboundWebhook(makeJob({ url: 'file:///etc/passwd', payload: {} }))
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a transport failure as retryable', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNRESET'));

    const error = await processOutboundWebhook(
      makeJob({ url: 'http://10.1.2.3/hook', payload: {} })
    ).catch((err) => err);

    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(error.message).toContain('ECONNRESET');
  });

  it('sends the BullMQ job id as the delivery id', async () => {
    await processOutboundWebhook(
      makeJob({ url: 'http://10.1.2.3/hook', payload: {} }, { id: 'job-42' })
    );

    const init = vi.mocked(fetch).mock.calls[0][1] as any;
    expect(init.headers[DELIVERY_HEADER]).toBe('job-42');
  });
});
