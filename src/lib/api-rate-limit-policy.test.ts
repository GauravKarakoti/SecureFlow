import { describe, it, expect } from 'vitest';
import {
  API_RATE_LIMIT_TIERS,
  AUTH_PREFIX,
  EXEMPT_PREFIXES,
  classifyApiPath,
  isApiPath,
  normalizeApiPath,
  rateLimitHeaders,
  retryAfterSeconds,
  tierForPath,
} from './api-rate-limit-policy';

describe('normalizeApiPath', () => {
  it('lower-cases and strips a trailing slash', () => {
    expect(normalizeApiPath('/API/Webhooks/GitHub/')).toBe('/api/webhooks/github');
  });

  it('collapses repeated slashes', () => {
    expect(normalizeApiPath('/api//webhooks///github')).toBe('/api/webhooks/github');
  });

  it('leaves the root alone', () => {
    expect(normalizeApiPath('/')).toBe('/');
  });

  it('handles an empty path', () => {
    expect(normalizeApiPath('')).toBe('');
  });
});

describe('isApiPath', () => {
  it.each(['/api', '/api/', '/api/leaderboard', '/API/leaderboard'])('accepts %s', (path) => {
    expect(isApiPath(path)).toBe(true);
  });

  it.each(['/', '/dashboard', '/apidocs', '/admin/api'])('rejects %s', (path) => {
    expect(isApiPath(path)).toBe(false);
  });
});

describe('classifyApiPath', () => {
  it('does not limit anything outside /api', () => {
    expect(classifyApiPath('/dashboard')).toBe('exempt');
    expect(classifyApiPath('/share/heist')).toBe('exempt');
    expect(classifyApiPath('/')).toBe('exempt');
  });

  it('exempts the GitHub webhook endpoint', () => {
    // This is the bug: GitHub delivers from a small pool of addresses, so a
    // busy minute put every installation's hooks in one IP bucket and the 21st
    // delivery got a 429 GitHub does not retry.
    expect(classifyApiPath('/api/webhooks/github')).toBe('exempt');
    expect(classifyApiPath('/api/webhooks')).toBe('exempt');
  });

  it('exempts the health probes', () => {
    // A platform health check that gets 429'd reads as an outage.
    expect(classifyApiPath('/api/health')).toBe('exempt');
    expect(classifyApiPath('/api/ready')).toBe('exempt');
  });

  it('exempts regardless of casing or trailing slashes', () => {
    // An exemption that a different spelling falls through is a bypass in the
    // wrong direction — the request would get limited, not waved past.
    expect(classifyApiPath('/API/Webhooks/GitHub/')).toBe('exempt');
    expect(classifyApiPath('/api//health/')).toBe('exempt');
  });

  it('puts NextAuth on its own class', () => {
    expect(classifyApiPath('/api/auth/session')).toBe('auth');
    expect(classifyApiPath('/api/auth/callback/github')).toBe('auth');
    expect(classifyApiPath('/api/auth')).toBe('auth');
  });

  it('puts the AI streaming routes on their own class', () => {
    expect(classifyApiPath('/api/heist-transmission')).toBe('stream');
    expect(classifyApiPath('/api/og/heist')).toBe('stream');
    expect(classifyApiPath('/api/findings/abc123/explain-stream')).toBe('stream');
  });

  it('falls back to standard for everything else under /api', () => {
    expect(classifyApiPath('/api/leaderboard')).toBe('standard');
    expect(classifyApiPath('/api/admin/export')).toBe('standard');
    expect(classifyApiPath('/api')).toBe('standard');
  });

  it('does not exempt a path that merely starts with the same characters', () => {
    // `/api/webhooks-admin` is not `/api/webhooks`. A prefix match on the raw
    // string would have exempted it.
    expect(classifyApiPath('/api/webhooks-admin')).toBe('standard');
    expect(classifyApiPath('/api/healthcheck')).toBe('standard');
    expect(classifyApiPath('/api/authorize')).toBe('standard');
  });
});

describe('API_RATE_LIMIT_TIERS', () => {
  it('gives every class its own key prefix', () => {
    // Sharing a prefix would put the classes back in one bucket, which is the
    // bug the classes exist to fix.
    const prefixes = Object.values(API_RATE_LIMIT_TIERS).map((tier) => tier.keyPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('keeps the previous global budget for standard traffic', () => {
    expect(API_RATE_LIMIT_TIERS.standard).toMatchObject({ limit: 20, windowSeconds: 60 });
  });

  it('gives auth a larger budget than standard', () => {
    // Session polling is cheap, and a shared NAT multiplies it across everyone
    // behind the same egress address.
    expect(API_RATE_LIMIT_TIERS.auth.limit).toBeGreaterThan(API_RATE_LIMIT_TIERS.standard.limit);
  });
});

describe('tierForPath', () => {
  it('returns null for an exempt path', () => {
    expect(tierForPath('/api/webhooks/github')).toBeNull();
    expect(tierForPath('/dashboard')).toBeNull();
  });

  it('returns the matching tier otherwise', () => {
    expect(tierForPath('/api/auth/session')).toBe(API_RATE_LIMIT_TIERS.auth);
    expect(tierForPath('/api/leaderboard')).toBe(API_RATE_LIMIT_TIERS.standard);
    expect(tierForPath('/api/heist-transmission')).toBe(API_RATE_LIMIT_TIERS.stream);
  });
});

describe('retryAfterSeconds', () => {
  it('reports the time actually left in the window', () => {
    // Not the full window length: a caller blocked one second into a 60s window
    // should not be told to wait 60 seconds.
    expect(retryAfterSeconds(10_000, 5_000)).toBe(5);
  });

  it('rounds up rather than down', () => {
    expect(retryAfterSeconds(10_500, 10_000)).toBe(1);
  });

  it('never returns zero or a negative', () => {
    expect(retryAfterSeconds(1_000, 5_000)).toBe(1);
    expect(retryAfterSeconds(5_000, 5_000)).toBe(1);
  });

  it('survives a non-finite reset', () => {
    expect(retryAfterSeconds(Number.NaN, 1_000)).toBe(1);
  });
});

describe('rateLimitHeaders', () => {
  it('advertises the budget on an allowed request', () => {
    const headers = rateLimitHeaders(
      { success: true, limit: 20, remaining: 7, reset: 1_700_000_060_000 },
      1_700_000_000_000
    );

    expect(headers).toEqual({
      'X-RateLimit-Limit': '20',
      'X-RateLimit-Remaining': '7',
      'X-RateLimit-Reset': '1700000060',
    });
  });

  it('adds Retry-After when the request was blocked', () => {
    const headers = rateLimitHeaders(
      { success: false, limit: 20, remaining: 0, reset: 1_700_000_030_000 },
      1_700_000_000_000
    );

    expect(headers['Retry-After']).toBe('30');
    expect(headers['X-RateLimit-Remaining']).toBe('0');
  });

  it('never reports a negative remaining', () => {
    const headers = rateLimitHeaders(
      { success: false, limit: 20, remaining: -3, reset: 1_700_000_030_000 },
      1_700_000_000_000
    );

    expect(headers['X-RateLimit-Remaining']).toBe('0');
  });

  it('expresses the reset in epoch seconds', () => {
    // Matching the GitHub API convention this project already talks to.
    const headers = rateLimitHeaders(
      { success: true, limit: 20, remaining: 1, reset: 1_700_000_060_500 },
      1_700_000_000_000
    );

    expect(headers['X-RateLimit-Reset']).toBe('1700000061');
  });
});

describe('exported prefixes', () => {
  it('are all absolute and unslashed at the end', () => {
    for (const prefix of [...EXEMPT_PREFIXES, AUTH_PREFIX]) {
      expect(prefix.startsWith('/api')).toBe(true);
      expect(prefix.endsWith('/')).toBe(false);
    }
  });
});
