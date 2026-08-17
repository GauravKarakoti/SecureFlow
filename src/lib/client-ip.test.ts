import { describe, it, expect } from 'vitest';
import {
  UNKNOWN_CLIENT_IP,
  getClientIp,
  normalizeIp,
  parseForwardedChain,
  parseTrustedProxies,
  resolveHopCount,
} from './client-ip';

/** Build a Headers instance from a plain object. */
function h(headers: Record<string, string>): Headers {
  return new Headers(headers);
}

describe('normalizeIp', () => {
  it('accepts a plain IPv4 address', () => {
    expect(normalizeIp('203.0.113.9')).toBe('203.0.113.9');
  });

  it('strips an IPv4 port', () => {
    expect(normalizeIp('203.0.113.9:8080')).toBe('203.0.113.9');
  });

  it('unwraps a bracketed IPv6 address, with or without a port', () => {
    expect(normalizeIp('[::1]')).toBe('::1');
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
  });

  it('does not truncate a bare IPv6 literal at its first colon', () => {
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('lowercases IPv6 so casing cannot split a bucket', () => {
    expect(normalizeIp('2001:DB8::AB')).toBe('2001:db8::ab');
  });

  it('collapses IPv4-mapped IPv6 onto the plain IPv4 form', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp('::FFFF:1.2.3.4')).toBe('1.2.3.4');
  });

  it('drops an IPv6 zone index', () => {
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeIp('  203.0.113.9  ')).toBe('203.0.113.9');
  });

  it('rejects out-of-range octets', () => {
    expect(normalizeIp('999.0.0.1')).toBeNull();
    expect(normalizeIp('256.1.1.1')).toBeNull();
  });

  it('rejects leading zeros, which would otherwise be a second bucket', () => {
    expect(normalizeIp('01.2.3.4')).toBeNull();
  });

  it('rejects a malformed IPv6 with two compression runs', () => {
    expect(normalizeIp('2001::db8::1')).toBeNull();
  });

  it('rejects free text, so header junk never reaches the Redis key', () => {
    expect(normalizeIp('not-an-ip')).toBeNull();
    expect(normalizeIp('<script>')).toBeNull();
    expect(normalizeIp('1.2.3.4; DEL *')).toBeNull();
  });

  it('rejects an oversized value', () => {
    expect(normalizeIp('1'.repeat(500))).toBeNull();
  });

  it('rejects empty and non-string input without throwing', () => {
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp('   ')).toBeNull();
    expect(normalizeIp(null)).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
    expect(normalizeIp(42 as unknown as string)).toBeNull();
  });
});

describe('parseForwardedChain', () => {
  it('splits and normalizes a chain left to right', () => {
    expect(parseForwardedChain('1.2.3.4, 5.6.7.8, 9.10.11.12')).toEqual([
      '1.2.3.4',
      '5.6.7.8',
      '9.10.11.12',
    ]);
  });

  it('drops invalid entries rather than keeping a position for them', () => {
    expect(parseForwardedChain('garbage, 5.6.7.8')).toEqual(['5.6.7.8']);
  });

  it('returns an empty chain for a missing or oversized header', () => {
    expect(parseForwardedChain(null)).toEqual([]);
    expect(parseForwardedChain('')).toEqual([]);
    expect(parseForwardedChain('1.2.3.4,'.repeat(500))).toEqual([]);
  });

  it('caps the number of entries it will parse', () => {
    const long = Array.from({ length: 100 }, (_, i) => `10.0.0.${i % 250}`).join(',');
    expect(parseForwardedChain(long).length).toBeLessThanOrEqual(32);
  });
});

describe('resolveHopCount', () => {
  it('defaults to one trusted hop', () => {
    expect(resolveHopCount(undefined)).toBe(1);
    expect(resolveHopCount('')).toBe(1);
    expect(resolveHopCount('   ')).toBe(1);
  });

  it('honours a valid value', () => {
    expect(resolveHopCount('0')).toBe(0);
    expect(resolveHopCount('2')).toBe(2);
  });

  it('falls back to the safe default for a malformed value', () => {
    expect(resolveHopCount('abc')).toBe(1);
    expect(resolveHopCount('-1')).toBe(1);
    expect(resolveHopCount('1.5')).toBe(1);
    expect(resolveHopCount('9999')).toBe(1);
  });
});

describe('parseTrustedProxies', () => {
  it('parses bare addresses', () => {
    expect(parseTrustedProxies('10.0.0.1, 10.0.0.2')).toHaveLength(2);
  });

  it('parses IPv4 CIDR blocks', () => {
    expect(parseTrustedProxies('10.0.0.0/8')).toEqual([
      { kind: 'cidr4', base: 167772160, mask: 4278190080 },
    ]);
  });

  it('drops unparseable entries instead of widening trust', () => {
    expect(parseTrustedProxies('nonsense, 10.0.0.0/99, 10.0.0.1')).toHaveLength(1);
  });

  it('returns an empty list for empty input', () => {
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies('')).toEqual([]);
  });
});

describe('getClientIp — spoofing', () => {
  const opts = { trustedHopCount: 1, trustedProxies: [] };

  it('ignores a spoofed left-most x-forwarded-for entry', () => {
    // The client typed "1.2.3.4"; the trusted proxy appended the real address.
    const ip = getClientIp(h({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }), opts);
    expect(ip).toBe('203.0.113.9');
  });

  it('ignores a spoofed x-real-ip when a chain is present', () => {
    const ip = getClientIp(
      h({ 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }),
      opts
    );
    expect(ip).toBe('203.0.113.9');
  });

  it('gives an attacker the same bucket no matter what they prepend', () => {
    // This is the bypass the issue describes: 500 requests, 500 buckets.
    const buckets = new Set(
      Array.from({ length: 50 }, (_, i) =>
        getClientIp(
          h({
            'x-real-ip': `10.0.0.${i}`,
            'x-forwarded-for': `10.1.2.${i}, 8.8.8.8, 203.0.113.9`,
          }),
          opts
        )
      )
    );

    expect(buckets.size).toBe(1);
    expect([...buckets][0]).toBe('203.0.113.9');
  });

  it('cannot be shifted by padding the chain with junk entries', () => {
    const ip = getClientIp(
      h({ 'x-forwarded-for': 'junk, junk, junk, 1.2.3.4, 203.0.113.9' }),
      opts
    );
    expect(ip).toBe('203.0.113.9');
  });
});

describe('getClientIp — hop counting', () => {
  it('reads the single trusted hop from the right', () => {
    expect(getClientIp(h({ 'x-forwarded-for': '203.0.113.9' }), { trustedHopCount: 1, trustedProxies: [] })).toBe(
      '203.0.113.9'
    );
  });

  it('reads two trusted hops from the right', () => {
    // client -> CDN -> LB -> app, so the chain is "client, CDN".
    const ip = getClientIp(h({ 'x-forwarded-for': '203.0.113.9, 10.0.0.7' }), {
      trustedHopCount: 2,
      trustedProxies: [],
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('still resolves correctly at two hops when the client prepends a lie', () => {
    const ip = getClientIp(h({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9, 10.0.0.7' }), {
      trustedHopCount: 2,
      trustedProxies: [],
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('returns the sentinel when the chain is shorter than the configured hops', () => {
    const ip = getClientIp(h({ 'x-forwarded-for': '203.0.113.9' }), {
      trustedHopCount: 3,
      trustedProxies: [],
    });
    expect(ip).toBe(UNKNOWN_CLIENT_IP);
  });

  it('ignores forwarding headers entirely when the app is directly exposed', () => {
    const ip = getClientIp(
      h({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' }),
      { trustedHopCount: 0, trustedProxies: [] }
    );
    expect(ip).toBe(UNKNOWN_CLIENT_IP);
  });
});

describe('getClientIp — trusted proxy allowlist', () => {
  const trustedProxies = parseTrustedProxies('10.0.0.0/8, 192.168.1.1');

  it('walks past known proxies from the right', () => {
    const ip = getClientIp(h({ 'x-forwarded-for': '203.0.113.9, 10.5.5.5, 10.0.0.7' }), {
      trustedHopCount: 1,
      trustedProxies,
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('matches an exact non-CIDR entry', () => {
    const ip = getClientIp(h({ 'x-forwarded-for': '203.0.113.9, 192.168.1.1' }), {
      trustedHopCount: 1,
      trustedProxies,
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('stops at the first untrusted hop, so a spoof cannot reach through', () => {
    const ip = getClientIp(h({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9, 10.0.0.7' }), {
      trustedHopCount: 1,
      trustedProxies,
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('falls back to the left-most entry when every hop is a known proxy', () => {
    const ip = getClientIp(h({ 'x-forwarded-for': '10.0.0.1, 10.0.0.2' }), {
      trustedHopCount: 1,
      trustedProxies,
    });
    expect(ip).toBe('10.0.0.1');
  });
});

describe('getClientIp — fallbacks', () => {
  const opts = { trustedHopCount: 1, trustedProxies: [] };

  it('uses x-real-ip when there is no forwarded chain', () => {
    expect(getClientIp(h({ 'x-real-ip': '203.0.113.9' }), opts)).toBe('203.0.113.9');
  });

  it('normalizes x-real-ip too', () => {
    expect(getClientIp(h({ 'x-real-ip': '::ffff:1.2.3.4' }), opts)).toBe('1.2.3.4');
    expect(getClientIp(h({ 'x-real-ip': '1.2.3.4:9999' }), opts)).toBe('1.2.3.4');
  });

  it('rejects an invalid x-real-ip rather than passing it through to the key', () => {
    expect(getClientIp(h({ 'x-real-ip': 'nonsense' }), opts)).toBe(UNKNOWN_CLIENT_IP);
  });

  it('returns the sentinel, not 127.0.0.1, when no headers are present', () => {
    // The old fallback collapsed every header-less caller into the loopback
    // bucket, so one noisy client rate-limited everyone else.
    expect(getClientIp(h({}), opts)).toBe(UNKNOWN_CLIENT_IP);
    expect(getClientIp(h({}), opts)).not.toBe('127.0.0.1');
  });

  it('never returns a value containing a Redis key separator', () => {
    const values = [
      getClientIp(h({ 'x-real-ip': 'a:b:c:d' }), opts),
      getClientIp(h({ 'x-forwarded-for': 'x, y' }), opts),
      getClientIp(h({}), opts),
    ];
    for (const value of values) {
      expect(value).not.toMatch(/[\s,]/);
      expect(value.length).toBeLessThanOrEqual(64);
    }
  });

  it('is deterministic for the same headers', () => {
    const headers = h({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' });
    expect(getClientIp(headers, opts)).toBe(getClientIp(headers, opts));
  });
});

describe('getClientIp — environment configuration', () => {
  it('defaults to one trusted hop when nothing is configured', () => {
    const previousHops = process.env.TRUSTED_PROXY_HOP_COUNT;
    const previousIps = process.env.TRUSTED_PROXY_IPS;
    delete process.env.TRUSTED_PROXY_HOP_COUNT;
    delete process.env.TRUSTED_PROXY_IPS;

    try {
      expect(getClientIp(h({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }))).toBe('203.0.113.9');
    } finally {
      if (previousHops !== undefined) process.env.TRUSTED_PROXY_HOP_COUNT = previousHops;
      if (previousIps !== undefined) process.env.TRUSTED_PROXY_IPS = previousIps;
    }
  });

  it('honours TRUSTED_PROXY_HOP_COUNT from the environment', () => {
    const previous = process.env.TRUSTED_PROXY_HOP_COUNT;
    process.env.TRUSTED_PROXY_HOP_COUNT = '2';

    try {
      expect(getClientIp(h({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9, 10.0.0.7' }))).toBe(
        '203.0.113.9'
      );
    } finally {
      if (previous === undefined) delete process.env.TRUSTED_PROXY_HOP_COUNT;
      else process.env.TRUSTED_PROXY_HOP_COUNT = previous;
    }
  });
});
