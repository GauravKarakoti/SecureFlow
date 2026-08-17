import { describe, it, expect } from 'vitest';
import nextConfig from '../../next.config';
import {
  HSTS_MAX_AGE_SECONDS,
  REMOTE_IMAGE_HOSTS,
  applySecurityHeaders,
  buildContentSecurityPolicy,
  buildCspDirectives,
  buildNextSecurityHeaderRules,
  buildPermissionsPolicy,
  buildSecurityHeaders,
  formatCspSource,
  isReportOnlyEnabled,
  securityHeaderOptionsFromEnv,
  serializeCspDirectives,
} from './security-headers';

/** Parse a serialised policy back into a directive -> sources map. */
function parsePolicy(policy: string): Record<string, string[]> {
  const parsed: Record<string, string[]> = {};
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    parsed[tokens[0]] = tokens.slice(1);
  }
  return parsed;
}

describe('formatCspSource', () => {
  it('quotes keyword sources', () => {
    expect(formatCspSource('self')).toBe("'self'");
    expect(formatCspSource('none')).toBe("'none'");
    expect(formatCspSource('unsafe-inline')).toBe("'unsafe-inline'");
    expect(formatCspSource('strict-dynamic')).toBe("'strict-dynamic'");
  });

  it('leaves origins, schemes and already-quoted values alone', () => {
    expect(formatCspSource('https://github.com')).toBe('https://github.com');
    expect(formatCspSource('data:')).toBe('data:');
    expect(formatCspSource("'nonce-abc123'")).toBe("'nonce-abc123'");
  });

  it('trims surrounding whitespace and drops empty sources', () => {
    expect(formatCspSource('  self  ')).toBe("'self'");
    expect(formatCspSource('   ')).toBe('');
  });
});

describe('serializeCspDirectives', () => {
  it('joins directives with "; " and sources with a space', () => {
    const policy = serializeCspDirectives({
      'default-src': ['self'],
      'img-src': ['self', 'data:'],
    });
    expect(policy).toBe("default-src 'self'; img-src 'self' data:");
  });

  it('emits a valueless directive as a bare name', () => {
    expect(serializeCspDirectives({ 'upgrade-insecure-requests': null })).toBe(
      'upgrade-insecure-requests'
    );
  });

  it('de-duplicates sources within a directive', () => {
    // Building a map by spreading a base and re-adding a source must not
    // produce `script-src 'self' 'self'`.
    expect(serializeCspDirectives({ 'script-src': ['self', 'self', 'unsafe-inline'] })).toBe(
      "script-src 'self' 'unsafe-inline'"
    );
  });

  it('drops a directive whose sources all filter out rather than emitting a bare name', () => {
    // A bare `script-src` means "block all scripts", which is a very different
    // policy from the empty one the caller wrote.
    expect(serializeCspDirectives({ 'script-src': ['', '   '] })).toBe('');
  });

  it('preserves insertion order', () => {
    const policy = serializeCspDirectives({
      'script-src': ['self'],
      'default-src': ['self'],
    });
    expect(policy.indexOf('script-src')).toBeLessThan(policy.indexOf('default-src'));
  });
});

describe('buildCspDirectives — production document policy', () => {
  const directives = buildCspDirectives({ isDev: false });

  it("locks the framing, object and base-tag sinks regardless of the script-src caveat", () => {
    expect(directives['frame-ancestors']).toEqual(['none']);
    expect(directives['frame-src']).toEqual(['none']);
    expect(directives['object-src']).toEqual(['none']);
    expect(directives['base-uri']).toEqual(['self']);
    expect(directives['form-action']).toEqual(['self']);
  });

  it('never allows unsafe-eval in production', () => {
    expect(directives['script-src']).not.toContain('unsafe-eval');
  });

  it('does not open connect-src to the HMR socket in production', () => {
    expect(directives['connect-src']).not.toContain('ws:');
    expect(directives['connect-src']).not.toContain('wss:');
    expect(directives['connect-src']).toContain('https://api.github.com');
  });

  it('requests HTTPS upgrades', () => {
    expect(directives).toHaveProperty('upgrade-insecure-requests', null);
  });
});

describe('buildCspDirectives — development', () => {
  const directives = buildCspDirectives({ isDev: true });

  it("allows Turbopack's eval-based HMR", () => {
    expect(directives['script-src']).toContain('unsafe-eval');
  });

  it('allows the HMR websocket, plain and tunnelled', () => {
    expect(directives['connect-src']).toEqual(
      expect.arrayContaining(['ws:', 'wss:'])
    );
  });

  it('does not force HTTPS upgrades against a local HTTP dev server', () => {
    expect(directives).not.toHaveProperty('upgrade-insecure-requests');
  });
});

describe('buildCspDirectives — nonce mode', () => {
  it('switches script-src to the nonce and drops unsafe-inline', () => {
    const directives = buildCspDirectives({ nonce: 'r4nd0m' });
    expect(directives['script-src']).toContain("'nonce-r4nd0m'");
    expect(directives['script-src']).toContain('strict-dynamic');
    expect(directives['script-src']).not.toContain('unsafe-inline');
  });

  it('falls back to unsafe-inline when no nonce is available', () => {
    // next.config.ts headers() are static and cannot mint a per-request nonce.
    const scriptSrc = buildCspDirectives({})['script-src'];
    expect(scriptSrc).toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('strict-dynamic');
  });
});

describe('buildCspDirectives — API policy', () => {
  const directives = buildCspDirectives({ apiRoute: true });

  it('denies everything, since no API response is rendered as a document', () => {
    expect(directives['default-src']).toEqual(['none']);
    expect(directives['frame-ancestors']).toEqual(['none']);
    expect(directives['base-uri']).toEqual(['none']);
    expect(directives['form-action']).toEqual(['none']);
  });

  it('carries no script or image sources at all', () => {
    expect(directives).not.toHaveProperty('script-src');
    expect(directives).not.toHaveProperty('img-src');
  });

  it('still honours a configured report collector', () => {
    expect(buildCspDirectives({ apiRoute: true, reportUri: '/csp' })['report-uri']).toEqual([
      '/csp',
    ]);
  });
});

describe('buildContentSecurityPolicy', () => {
  it('allows every remote image host the app is configured to load', () => {
    const parsed = parsePolicy(buildContentSecurityPolicy());
    for (const host of REMOTE_IMAGE_HOSTS) {
      expect(parsed['img-src']).toContain(host);
    }
    // GitHub avatars and the `github.com/<user>.png` leaderboard fallback are
    // both used by <Image>, so a missing entry breaks the leaderboard.
    expect(parsed['img-src']).toContain('https://avatars.githubusercontent.com');
  });

  it('permits data: and blob: images for the OG route and inline SVGs', () => {
    const parsed = parsePolicy(buildContentSecurityPolicy());
    expect(parsed['img-src']).toEqual(expect.arrayContaining(['data:', 'blob:']));
  });

  it('accepts a caller-supplied image allowlist', () => {
    const parsed = parsePolicy(buildContentSecurityPolicy({ imageHosts: ['https://cdn.test'] }));
    expect(parsed['img-src']).toContain('https://cdn.test');
    expect(parsed['img-src']).not.toContain('https://placehold.co');
  });
});

describe('REMOTE_IMAGE_HOSTS vs next.config.ts', () => {
  it('covers every host in images.remotePatterns', () => {
    // The two lists live in different files by necessity — this module must not
    // import Next types — so this assertion is what actually keeps them honest.
    const patterns = nextConfig.images?.remotePatterns ?? [];
    const configured = patterns.map(
      (pattern) => `${(pattern as { protocol?: string }).protocol ?? 'https'}://${(pattern as { hostname?: string }).hostname}`
    );

    expect(configured.length).toBeGreaterThan(0);
    for (const host of configured) {
      expect(REMOTE_IMAGE_HOSTS).toContain(host);
    }
  });
});

describe('buildPermissionsPolicy', () => {
  it('denies every high-risk capability the app never uses', () => {
    const policy = buildPermissionsPolicy();
    for (const feature of ['camera', 'microphone', 'geolocation', 'usb', 'payment']) {
      expect(policy).toContain(`${feature}=()`);
    }
  });

  it('is a comma-separated list with no empty entries', () => {
    const entries = buildPermissionsPolicy().split(',').map((entry) => entry.trim());
    expect(entries.every((entry) => /^[a-z-]+=\(\)$/.test(entry))).toBe(true);
  });
});

describe('buildSecurityHeaders', () => {
  it('sets the full baseline in production', () => {
    const headers = buildSecurityHeaders({ isDev: false });
    expect(Object.keys(headers)).toEqual(
      expect.arrayContaining([
        'Content-Security-Policy',
        'Strict-Transport-Security',
        'X-Frame-Options',
        'X-Content-Type-Options',
        'Referrer-Policy',
        'Permissions-Policy',
        'Cross-Origin-Opener-Policy',
        'Cross-Origin-Resource-Policy',
      ])
    );
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('pins HSTS to a preload-eligible max-age', () => {
    expect(buildSecurityHeaders({ isDev: false })['Strict-Transport-Security']).toBe(
      `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains; preload`
    );
    expect(HSTS_MAX_AGE_SECONDS).toBeGreaterThanOrEqual(31536000);
  });

  it('omits HSTS in development so localhost is not pinned to HTTPS for two years', () => {
    expect(buildSecurityHeaders({ isDev: true })).not.toHaveProperty(
      'Strict-Transport-Security'
    );
  });

  it('switches to the report-only header without changing the policy body', () => {
    const enforcing = buildSecurityHeaders({ reportOnly: false });
    const reporting = buildSecurityHeaders({ reportOnly: true });

    expect(reporting).not.toHaveProperty('Content-Security-Policy');
    expect(reporting['Content-Security-Policy-Report-Only']).toBe(
      enforcing['Content-Security-Policy']
    );
  });

  it('marks API responses as uncacheable', () => {
    expect(buildSecurityHeaders({ apiRoute: true })['Cache-Control']).toBe(
      'no-store, max-age=0'
    );
    expect(buildSecurityHeaders({ apiRoute: false })).not.toHaveProperty('Cache-Control');
  });

  it('disables the legacy XSS auditor rather than enabling it', () => {
    expect(buildSecurityHeaders()['X-XSS-Protection']).toBe('0');
  });
});

describe('isReportOnlyEnabled', () => {
  it.each(['true', 'TRUE', ' true ', '1', 'yes'])('treats %j as enabled', (value) => {
    expect(isReportOnlyEnabled(value)).toBe(true);
  });

  it.each([undefined, '', 'false', '0', 'no', 'maybe'])('treats %j as disabled', (value) => {
    expect(isReportOnlyEnabled(value)).toBe(false);
  });
});

describe('securityHeaderOptionsFromEnv', () => {
  it('reads dev mode, report-only and the report collector', () => {
    expect(
      securityHeaderOptionsFromEnv({
        NODE_ENV: 'development',
        CSP_REPORT_ONLY: 'true',
        CSP_REPORT_URI: ' /api/csp-report ',
      } as NodeJS.ProcessEnv)
    ).toEqual({ isDev: true, reportOnly: true, reportUri: '/api/csp-report' });
  });

  it('defaults to enforcing production headers with no collector', () => {
    expect(securityHeaderOptionsFromEnv({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toEqual({
      isDev: false,
      reportOnly: false,
      reportUri: undefined,
    });
  });

  it('ignores a blank CSP_REPORT_URI instead of emitting an empty report-uri', () => {
    expect(
      securityHeaderOptionsFromEnv({
        NODE_ENV: 'production',
        CSP_REPORT_URI: '   ',
      } as NodeJS.ProcessEnv).reportUri
    ).toBeUndefined();
  });
});

describe('buildNextSecurityHeaderRules', () => {
  const rules = buildNextSecurityHeaderRules({ isDev: false });

  it('emits the API rule before the catch-all so its values win', () => {
    expect(rules.map((rule) => rule.source)).toEqual(['/api/:path*', '/:path*']);
  });

  it('gives API routes the deny-all policy and pages the document policy', () => {
    const apiCsp = rules[0].headers.find((h) => h.key === 'Content-Security-Policy')!.value;
    const pageCsp = rules[1].headers.find((h) => h.key === 'Content-Security-Policy')!.value;

    expect(apiCsp).toContain("default-src 'none'");
    expect(pageCsp).toContain("default-src 'self'");
    expect(pageCsp).toContain("frame-ancestors 'none'");
  });

  it('produces header entries in the {key, value} shape next.config expects', () => {
    for (const rule of rules) {
      expect(rule.headers.length).toBeGreaterThan(0);
      for (const header of rule.headers) {
        expect(typeof header.key).toBe('string');
        expect(typeof header.value).toBe('string');
        expect(header.value.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('applySecurityHeaders', () => {
  function fakeResponse() {
    const store = new Map<string, string>();
    return {
      store,
      headers: {
        set: (name: string, value: string) => {
          store.set(name, value);
        },
      },
    };
  }

  it('writes every header onto the response and returns it', () => {
    const response = fakeResponse();
    const returned = applySecurityHeaders(response, { isDev: false });

    expect(returned).toBe(response);
    expect(response.store.get('X-Frame-Options')).toBe('DENY');
    expect(response.store.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(response.store.get('Strict-Transport-Security')).toBeDefined();
  });

  it('overwrites an existing value rather than appending a second one', () => {
    // Two Content-Security-Policy headers are intersected by the browser, which
    // produces a policy stricter than either — a silent way to break the app.
    const response = fakeResponse();
    response.headers.set('Content-Security-Policy', "default-src 'none'");
    applySecurityHeaders(response);

    expect(response.store.get('Content-Security-Policy')).toContain("default-src 'self'");
  });
});
