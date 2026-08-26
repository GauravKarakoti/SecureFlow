import { describe, it, expect, vi } from 'vitest';
import {
  DELIVERY_HEADER,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  OutboundDeliveryError,
  OutboundDestinationError,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  assertDispatchableUrl,
  buildSignatureHeader,
  classifyResponseStatus,
  describeDestination,
  dispatchOutboundWebhook,
  drainBody,
  isBlockedHostname,
  isPrivateAddress,
  isPrivateIPv4,
  isPrivateIPv6,
  resolveDispatchConfig,
  verifySignatureHeader,
  type DispatchConfig,
} from './outbound-dispatch';

/** A config that skips DNS-dependent behaviour unless a test opts into it. */
function config(overrides: Partial<DispatchConfig> = {}): DispatchConfig {
  return {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    allowedHosts: [],
    allowInsecureHttp: false,
    allowPrivateNetworks: false,
    ...overrides,
  };
}

/** Resolver stub — every hostname answers with the same public address. */
const publicResolver = async () => ['93.184.216.34'];

/** Build a `ProcessEnv`-shaped object without dragging in the real one. */
function env(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return values as unknown as NodeJS.ProcessEnv;
}

describe('isPrivateIPv4', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.0.1',
    '100.64.0.1',
    '198.18.0.1',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
  ])('rejects %s', (address) => {
    expect(isPrivateIPv4(address)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '172.32.0.1', '172.15.0.1', '1.1.1.1', '192.169.0.1'])(
    'allows %s',
    (address) => {
      expect(isPrivateIPv4(address)).toBe(false);
    }
  );

  it('only recognises canonical dotted-quad notation', () => {
    // Anything that is not four decimal octets is "not an IPv4 literal" as far
    // as this function is concerned, so it falls through to the hostname path
    // rather than being silently misparsed here. The obfuscated spellings are
    // handled a layer up — see the URL-level test below.
    expect(isPrivateIPv4('0x7f.0.0.1')).toBe(false);
    expect(isPrivateIPv4('127.0.0')).toBe(false);
    expect(isPrivateIPv4('127.0.0.1.1')).toBe(false);
    expect(isPrivateIPv4('999.0.0.1')).toBe(false);
    expect(isPrivateIPv4('not.an.ip.address')).toBe(false);
  });
});

describe('isPrivateIPv6', () => {
  it.each(['::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1'])(
    'rejects %s',
    (address) => {
      expect(isPrivateIPv6(address)).toBe(true);
    }
  );

  it('unwraps IPv4-mapped addresses before deciding', () => {
    expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIPv6('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateIPv6('::ffff:8.8.8.8')).toBe(false);
  });

  it('unwraps the hextet spelling the URL parser produces', () => {
    // `new URL('https://[::ffff:127.0.0.1]/')` normalises the hostname to
    // `[::ffff:7f00:1]`, so matching only the dotted form would catch nothing
    // by the time the check actually runs.
    expect(isPrivateIPv6('::ffff:7f00:1')).toBe(true);
    expect(isPrivateIPv6('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isPrivateIPv6('::ffff:0808:0808')).toBe(false); // 8.8.8.8
  });

  it('strips brackets and zone identifiers', () => {
    expect(isPrivateIPv6('[fe80::1%eth0]')).toBe(true);
  });

  it('allows a public v6 address', () => {
    expect(isPrivateIPv6('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });
});

describe('isPrivateAddress', () => {
  it('routes to the right family and treats an empty value as unsafe', () => {
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('')).toBe(true);
  });
});

describe('isBlockedHostname', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'metadata.google.internal',
    'instance-data',
    'api.localhost',
    'redis.internal',
    'localhost.',
  ])('blocks %s', (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(true);
  });

  it('allows an ordinary public hostname', () => {
    expect(isBlockedHostname('hooks.example.com')).toBe(false);
  });
});

describe('resolveDispatchConfig', () => {
  it('falls back to the documented defaults', () => {
    const resolved = resolveDispatchConfig(env({}));
    expect(resolved.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolved.maxResponseBytes).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    expect(resolved.allowedHosts).toEqual([]);
    expect(resolved.allowInsecureHttp).toBe(false);
    expect(resolved.allowPrivateNetworks).toBe(false);
  });

  it('parses the allowlist and lowercases it', () => {
    const resolved = resolveDispatchConfig(env({
      OUTBOUND_WEBHOOK_ALLOWED_HOSTS: ' Hooks.Example.com , other.example.com ,,',
    }));
    expect(resolved.allowedHosts).toEqual(['hooks.example.com', 'other.example.com']);
  });

  it('caps the timeout and ignores nonsense values', () => {
    expect(
      resolveDispatchConfig(env({ OUTBOUND_WEBHOOK_TIMEOUT_MS: '999999' })).timeoutMs
    ).toBe(MAX_TIMEOUT_MS);
    expect(
      resolveDispatchConfig(env({ OUTBOUND_WEBHOOK_TIMEOUT_MS: 'soon' })).timeoutMs
    ).toBe(DEFAULT_TIMEOUT_MS);
    expect(
      resolveDispatchConfig(env({ OUTBOUND_WEBHOOK_TIMEOUT_MS: '-5' })).timeoutMs
    ).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('honours the permissive switches outside production', () => {
    const resolved = resolveDispatchConfig(env({
      NODE_ENV: 'development',
      OUTBOUND_WEBHOOK_ALLOW_INSECURE_HTTP: 'true',
      OUTBOUND_WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true',
    }));
    expect(resolved.allowInsecureHttp).toBe(true);
    expect(resolved.allowPrivateNetworks).toBe(true);
  });

  it('ignores the permissive switches in production', () => {
    // The guard must not be disableable by an environment variable — that is
    // how these end up off in the one place they matter.
    const resolved = resolveDispatchConfig(env({
      NODE_ENV: 'production',
      OUTBOUND_WEBHOOK_ALLOW_INSECURE_HTTP: 'true',
      OUTBOUND_WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true',
    }));
    expect(resolved.allowInsecureHttp).toBe(false);
    expect(resolved.allowPrivateNetworks).toBe(false);
  });
});

describe('assertDispatchableUrl', () => {
  const options = { config: config(), resolve: publicResolver };

  it('accepts a public https destination', async () => {
    const url = await assertDispatchableUrl('https://hooks.example.com/deliver', options);
    expect(url.hostname).toBe('hooks.example.com');
  });

  it.each([
    ['file:///etc/passwd', 'Unsupported webhook scheme'],
    ['gopher://example.com/', 'Unsupported webhook scheme'],
    ['redis://example.com:6379', 'Unsupported webhook scheme'],
  ])('rejects the scheme in %s', async (url, expected) => {
    await expect(assertDispatchableUrl(url, options)).rejects.toThrow(expected);
  });

  it('rejects plaintext http by default and allows it when configured', async () => {
    await expect(assertDispatchableUrl('http://hooks.example.com/x', options)).rejects.toBeInstanceOf(
      OutboundDestinationError
    );

    const permissive = { config: config({ allowInsecureHttp: true }), resolve: publicResolver };
    await expect(assertDispatchableUrl('http://hooks.example.com/x', permissive)).resolves.toBeInstanceOf(
      URL
    );
  });

  it('rejects an empty or unparseable URL', async () => {
    await expect(assertDispatchableUrl('', options)).rejects.toThrow('missing');
    await expect(assertDispatchableUrl('   ', options)).rejects.toThrow('missing');
    await expect(assertDispatchableUrl('not-a-url', options)).rejects.toThrow('valid absolute URL');
  });

  it('rejects credentials embedded in the authority', async () => {
    await expect(
      assertDispatchableUrl('https://user:pass@hooks.example.com/x', options)
    ).rejects.toThrow('must not embed credentials');
  });

  it.each([
    'https://127.0.0.1/hook',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/admin',
    'https://192.168.1.1/hook',
    'https://[::1]/hook',
    'https://[fe80::1]/hook',
  ])('rejects the literal address in %s', async (url) => {
    await expect(assertDispatchableUrl(url, options)).rejects.toBeInstanceOf(
      OutboundDestinationError
    );
  });

  it.each([
    'https://0x7f.0.0.1/hook',
    'https://2130706433/hook',
    'https://0177.0.0.1/hook',
    'https://[::ffff:127.0.0.1]/hook',
  ])('rejects the obfuscated loopback spelling in %s', async (url) => {
    // The WHATWG URL parser canonicalises hex, octal and integer forms back to
    // a dotted quad before we ever see `url.hostname`, so checking the
    // canonical form is enough — as long as we check it *after* parsing and not
    // on the raw string.
    await expect(assertDispatchableUrl(url, options)).rejects.toBeInstanceOf(
      OutboundDestinationError
    );
  });

  it('rejects internal hostnames without needing DNS', async () => {
    const resolve = vi.fn(publicResolver);
    await expect(
      assertDispatchableUrl('https://localhost/hook', { config: config(), resolve })
    ).rejects.toThrow('internal host');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a public-looking name that resolves into a private range', async () => {
    // DNS rebinding: the hostname passes every syntactic check and the answer
    // is loopback. Checking the name alone would have let this through.
    const resolve = async () => ['203.0.113.10', '127.0.0.1'];
    await expect(
      assertDispatchableUrl('https://evil.example.com/hook', { config: config(), resolve })
    ).rejects.toThrow('resolves to the internal address');
  });

  it('treats an unresolvable host as a retryable delivery failure, not a bad destination', async () => {
    const resolve = async () => {
      throw new Error('ENOTFOUND');
    };
    const error = await assertDispatchableUrl('https://gone.example.com/hook', {
      config: config(),
      resolve,
    }).catch((err) => err);

    expect(error).toBeInstanceOf(OutboundDeliveryError);
    expect(error.retryable).toBe(true);
  });

  it('treats an empty DNS answer as retryable', async () => {
    const error = await assertDispatchableUrl('https://empty.example.com/hook', {
      config: config(),
      resolve: async () => [],
    }).catch((err) => err);

    expect(error).toBeInstanceOf(OutboundDeliveryError);
    expect(error.retryable).toBe(true);
  });

  it('enforces the host allowlist before resolving anything', async () => {
    const resolve = vi.fn(publicResolver);
    const allowlisted = { config: config({ allowedHosts: ['hooks.example.com'] }), resolve };

    await expect(
      assertDispatchableUrl('https://elsewhere.example.com/hook', allowlisted)
    ).rejects.toThrow('OUTBOUND_WEBHOOK_ALLOWED_HOSTS');
    expect(resolve).not.toHaveBeenCalled();

    await expect(
      assertDispatchableUrl('https://hooks.example.com/hook', allowlisted)
    ).resolves.toBeInstanceOf(URL);
  });

  it('skips every network check when private networks are explicitly allowed', async () => {
    const permissive = {
      config: config({ allowPrivateNetworks: true, allowInsecureHttp: true }),
      resolve: publicResolver,
    };
    await expect(assertDispatchableUrl('http://127.0.0.1:9002/hook', permissive)).resolves.toBeInstanceOf(
      URL
    );
  });
});

describe('signatures', () => {
  it('signs over the timestamp and the body, not the body alone', () => {
    const header = buildSignatureHeader('shhh', '{"a":1}', 1_700_000_000);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);

    // Changing only the timestamp must change the digest — that is what makes a
    // replay detectable.
    const other = buildSignatureHeader('shhh', '{"a":1}', 1_700_000_001);
    expect(other).not.toBe(header);
  });

  it('verifies a signature it produced', () => {
    const now = 1_700_000_000;
    const header = buildSignatureHeader('shhh', 'body', now);
    expect(verifySignatureHeader(header, 'shhh', 'body', 300, now)).toBe(true);
  });

  it('rejects a wrong secret, a tampered body and a stale timestamp', () => {
    const now = 1_700_000_000;
    const header = buildSignatureHeader('shhh', 'body', now);

    expect(verifySignatureHeader(header, 'other', 'body', 300, now)).toBe(false);
    expect(verifySignatureHeader(header, 'shhh', 'tampered', 300, now)).toBe(false);
    expect(verifySignatureHeader(header, 'shhh', 'body', 300, now + 3600)).toBe(false);
  });

  it('rejects a malformed header rather than throwing', () => {
    expect(verifySignatureHeader('garbage', 'shhh', 'body')).toBe(false);
    expect(verifySignatureHeader('t=abc,v1=00', 'shhh', 'body')).toBe(false);
    expect(verifySignatureHeader('t=1700000000', 'shhh', 'body', 300, 1_700_000_000)).toBe(false);
  });
});

describe('classifyResponseStatus', () => {
  it.each([200, 201, 202, 204, 299])('treats %i as success', (status) => {
    expect(classifyResponseStatus(status)).toBe('success');
  });

  it.each([408, 425, 429, 500, 502, 503, 504])('treats %i as retryable', (status) => {
    expect(classifyResponseStatus(status)).toBe('retryable');
  });

  it.each([301, 302, 307, 400, 401, 403, 404, 410, 422])(
    'treats %i as permanent',
    (status) => {
      expect(classifyResponseStatus(status)).toBe('permanent');
    }
  );
});

describe('describeDestination', () => {
  it('keeps the scheme, host and port and drops everything that could carry a token', () => {
    expect(describeDestination(new URL('https://hooks.example.com/t/AbC123?key=secret'))).toBe(
      'https://hooks.example.com'
    );
    expect(describeDestination(new URL('https://hooks.example.com:8443/x'))).toBe(
      'https://hooks.example.com:8443'
    );
  });
});

describe('drainBody', () => {
  it('reads a short body in full', async () => {
    const response = new Response('all good');
    expect(await drainBody(response, 1024)).toBe('all good');
  });

  it('stops at the cap instead of buffering whatever the receiver sends', async () => {
    const response = new Response('x'.repeat(5000));
    const drained = await drainBody(response, 32);
    expect(drained).toHaveLength(32);
  });

  it('returns an empty string for a body-less response', async () => {
    expect(await drainBody(new Response(null, { status: 204 }), 1024)).toBe('');
  });
});

describe('dispatchOutboundWebhook', () => {
  const baseOptions = {
    config: config(),
    resolve: publicResolver,
    now: () => 1_700_000_000_000,
  };

  it('posts the payload with a manual redirect policy and a deadline', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));

    const result = await dispatchOutboundWebhook(
      { url: 'https://hooks.example.com/deliver', payload: { event: 'scan.completed' } },
      { ...baseOptions, fetchImpl, deliveryId: 'delivery-1' }
    );

    expect(result.status).toBe(200);
    expect(result.destination).toBe('https://hooks.example.com');
    expect(result.deliveryId).toBe('delivery-1');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://hooks.example.com/deliver');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBe(JSON.stringify({ event: 'scan.completed' }));
    expect(init.headers[DELIVERY_HEADER]).toBe('delivery-1');
    expect(init.headers[SIGNATURE_HEADER]).toBeUndefined();
  });

  it('adds a timestamped signature when a secret is present', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));

    await dispatchOutboundWebhook(
      { url: 'https://hooks.example.com/deliver', payload: '{"a":1}', secret: 'shhh' },
      { ...baseOptions, fetchImpl }
    );

    const { headers } = fetchImpl.mock.calls[0][1];
    expect(headers[TIMESTAMP_HEADER]).toBe('1700000000');
    expect(verifySignatureHeader(headers[SIGNATURE_HEADER], 'shhh', '{"a":1}', 300, 1_700_000_000)).toBe(
      true
    );
  });

  it('passes a string payload through untouched', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));

    await dispatchOutboundWebhook(
      { url: 'https://hooks.example.com/deliver', payload: 'raw-body' },
      { ...baseOptions, fetchImpl }
    );

    expect(fetchImpl.mock.calls[0][1].body).toBe('raw-body');
  });

  it('never opens a socket for a refused destination', async () => {
    const fetchImpl = vi.fn();

    await expect(
      dispatchOutboundWebhook(
        { url: 'https://169.254.169.254/latest/meta-data/', payload: {} },
        { ...baseOptions, fetchImpl }
      )
    ).rejects.toBeInstanceOf(OutboundDestinationError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a redirect as a permanent failure rather than a hop to follow', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1' } }));

    const error = await dispatchOutboundWebhook(
      { url: 'https://hooks.example.com/deliver', payload: {} },
      { ...baseOptions, fetchImpl }
    ).catch((err) => err);

    expect(error).toBeInstanceOf(OutboundDeliveryError);
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(302);
    expect(error.message).toContain('not followed');
  });

  it('marks a 5xx retryable and a 4xx permanent', async () => {
    const serverError = await dispatchOutboundWebhook(
      { url: 'https://hooks.example.com/deliver', payload: {} },
      { ...baseOptions, fetchImpl: vi.fn().mockResolvedValue(new Response('boom', { status: 503 })) }
    ).catch((err) => err);
    expect(serverError.retryable).toBe(true);
    expect(serverError.status).toBe(503);

    const clientError = await dispatchOutboundWebhook(
      { url: 'https://hooks.example.com/deliver', payload: {} },
      { ...baseOptions, fetchImpl: vi.fn().mockResolvedValue(new Response('nope', { status: 404 })) }
    ).catch((err) => err);
    expect(clientError.retryable).toBe(false);
    expect(clientError.status).toBe(404);
  });

  it('keeps 429 retryable', async () => {
    const error = await dispatchOutboundWebhook(
      { url: 'https://hooks.example.com/deliver', payload: {} },
      { ...baseOptions, fetchImpl: vi.fn().mockResolvedValue(new Response('slow down', { status: 429 })) }
    ).catch((err) => err);

    expect(error.retryable).toBe(true);
  });

  it('reports a timeout as retryable and names the deadline', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    const error = await dispatchOutboundWebhook(
      { url: 'https://hooks.example.com/deliver', payload: {} },
      { ...baseOptions, fetchImpl: vi.fn().mockRejectedValue(timeout) }
    ).catch((err) => err);

    expect(error).toBeInstanceOf(OutboundDeliveryError);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('timed out');
    expect(error.message).toContain(String(DEFAULT_TIMEOUT_MS));
  });

  it('reports a transport failure as retryable', async () => {
    const error = await dispatchOutboundWebhook(
      { url: 'https://hooks.example.com/deliver', payload: {} },
      { ...baseOptions, fetchImpl: vi.fn().mockRejectedValue(new Error('ECONNRESET')) }
    ).catch((err) => err);

    expect(error.retryable).toBe(true);
    expect(error.message).toContain('ECONNRESET');
  });

  it('never puts the full destination URL in an error message', async () => {
    const error = await dispatchOutboundWebhook(
      { url: 'https://hooks.example.com/t/SUPERSECRETTOKEN', payload: {} },
      { ...baseOptions, fetchImpl: vi.fn().mockResolvedValue(new Response('no', { status: 400 })) }
    ).catch((err) => err);

    expect(error.message).not.toContain('SUPERSECRETTOKEN');
    expect(error.message).toContain('https://hooks.example.com');
  });

  it('returns a bounded preview of the receiver response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('y'.repeat(500), { status: 200 }));

    const result = await dispatchOutboundWebhook(
      { url: 'https://hooks.example.com/deliver', payload: {} },
      { ...baseOptions, config: config({ maxResponseBytes: 16 }), fetchImpl }
    );

    expect(result.bodyPreview).toHaveLength(16);
  });
});
