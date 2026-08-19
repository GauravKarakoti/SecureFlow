/**
 * HTTP security response headers.
 *
 * The application shipped without any of these: `next.config.ts` had no
 * `headers()` and `src/proxy.ts` returned bare `NextResponse` objects, so every
 * page and every API route was served with browser defaults. For a product that
 * exists to flag misconfigurations in other people's repositories, that was the
 * most visible misconfiguration we had.
 *
 * Everything here is pure. The builders take their inputs as arguments and
 * return plain objects, so the policy can be asserted in a unit test without a
 * running server — the same shape as `src/lib/client-ip.ts` and
 * `src/lib/middleware/http-status.ts`.
 *
 * Where the headers are attached
 * ------------------------------
 * `next.config.ts` `headers()` covers pages, static assets and API routes, and
 * is where the headers normally come from. `src/proxy.ts` additionally calls
 * `applySecurityHeaders()` on the responses **it constructs itself** — the 401
 * and 403 from the admin guard and the 429 from the rate limiter — because
 * those short-circuit before the route layer that applies `headers()` runs.
 *
 * `applySecurityHeaders` is deliberately *not* called on `NextResponse.next()`:
 * that response continues through the routing layer and would end up with two
 * `Content-Security-Policy` headers. A browser intersects multiple CSP headers,
 * so a duplicate is not merely redundant — it silently produces a policy
 * stricter than either one on its own.
 */

/**
 * Directive map. `null` means "emit the directive name with no value", which is
 * how valueless directives such as `upgrade-insecure-requests` are written.
 */
export type CspDirectives = Record<string, string[] | null>;

/** Sources that are keywords rather than origins, and therefore need quoting. */
const KEYWORD_SOURCES = new Set([
  'self',
  'none',
  'unsafe-inline',
  'unsafe-eval',
  'strict-dynamic',
  'unsafe-hashes',
  'wasm-unsafe-eval',
]);

/**
 * Image hosts the app is already allowed to load from.
 *
 * These mirror `images.remotePatterns` in `next.config.ts`. They are declared
 * here rather than imported so this module stays free of Next.js types (the
 * worker and the tests both load it outside the Next runtime); the
 * `security-headers.test.ts` suite asserts the two lists agree, which is what
 * actually stops them drifting.
 */
export const REMOTE_IMAGE_HOSTS = [
  'https://placehold.co',
  'https://images.unsplash.com',
  'https://picsum.photos',
  'https://avatars.githubusercontent.com',
  'https://github.com',
] as const;

/** Default cap for HSTS: two years, the value the preload list requires. */
export const HSTS_MAX_AGE_SECONDS = 63072000;

export interface SecurityHeaderOptions {
  /**
   * Development build. Turbopack's HMR client needs `'unsafe-eval'` and a
   * WebSocket connect source; production must have neither.
   */
  isDev?: boolean;
  /**
   * Per-request nonce. When supplied, `script-src` switches to
   * `'nonce-…' 'strict-dynamic'` and drops `'unsafe-inline'`. A nonce can only
   * be minted per request, so `next.config.ts` never passes one — see
   * `buildContentSecurityPolicy` for why the nonce-less policy is still worth
   * enforcing.
   */
  nonce?: string;
  /** Emit `Content-Security-Policy-Report-Only` instead of the enforcing header. */
  reportOnly?: boolean;
  /** Optional `report-uri`/`report-to` collector endpoint. */
  reportUri?: string;
  /** Override the image allowlist. Defaults to {@link REMOTE_IMAGE_HOSTS}. */
  imageHosts?: readonly string[];
  /**
   * Tight policy for `/api/*`, where nothing is ever rendered as a document.
   * Everything collapses to `default-src 'none'`.
   */
  apiRoute?: boolean;
}

/**
 * Quote a CSP source when it is a keyword.
 *
 * `self` and `'self'` are not the same token to a browser: unquoted, `self` is
 * parsed as a hostname, so a policy written without the quotes silently allows
 * a host called "self" and nothing else.
 */
export function formatCspSource(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) return '';
  if (KEYWORD_SOURCES.has(trimmed)) return `'${trimmed}'`;
  // Hashes and nonces are already written in their quoted form by the caller.
  return trimmed;
}

/**
 * Serialise a directive map into a policy string.
 *
 * Directives are emitted in insertion order and de-duplicated per directive, so
 * building a map by spreading a base and overriding a key cannot produce
 * `script-src 'self' 'self'`.
 */
export function serializeCspDirectives(directives: CspDirectives): string {
  const parts: string[] = [];

  for (const [directive, sources] of Object.entries(directives)) {
    if (sources === null) {
      parts.push(directive);
      continue;
    }

    const seen = new Set<string>();
    const formatted: string[] = [];

    for (const source of sources) {
      const value = formatCspSource(source);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      formatted.push(value);
    }

    // A directive with no sources left after filtering would serialise to a
    // bare name, which for `script-src` means "block everything" — a very
    // different policy from the one the caller wrote. Skip it instead.
    if (formatted.length === 0) continue;

    parts.push(`${directive} ${formatted.join(' ')}`);
  }

  return parts.join('; ');
}

/**
 * Build the directive map for the given environment.
 *
 * On `script-src` and `'unsafe-inline'`
 * ------------------------------------
 * Next.js injects inline bootstrap scripts and inline flight data into every
 * document. Without a per-request nonce there is no way to enforce
 * `script-src 'self'` without breaking hydration, so the nonce-less policy
 * keeps `'unsafe-inline'`.
 *
 * That does weaken the anti-XSS value of the policy, and pretending otherwise
 * would be worse than saying so. It does **not** make the header pointless:
 * `frame-ancestors 'none'` stops the clickjacking of the one-click triage and
 * policy-toggle controls, `object-src 'none'` removes the plugin sinks,
 * `base-uri 'self'` blocks base-tag injection from redirecting every relative
 * script URL, and `form-action 'self'` stops an injected form from posting a
 * session elsewhere. Those are enforced regardless of the script-src caveat.
 *
 * Callers that can mint a nonce get the strict form for free by passing one.
 */
export function buildCspDirectives(options: SecurityHeaderOptions = {}): CspDirectives {
  const { isDev = false, nonce, reportUri, imageHosts = REMOTE_IMAGE_HOSTS, apiRoute = false } =
    options;

  if (apiRoute) {
    // No API response is ever rendered as a document, so the safest policy is
    // also the simplest one.
    const apiDirectives: CspDirectives = {
      'default-src': ['none'],
      'frame-ancestors': ['none'],
      'base-uri': ['none'],
      'form-action': ['none'],
    };
    if (reportUri) apiDirectives['report-uri'] = [reportUri];
    return apiDirectives;
  }

  const scriptSrc = nonce
    ? [`'nonce-${nonce}'`, 'strict-dynamic', 'self']
    : ['self', 'unsafe-inline'];

  if (isDev) {
    // Turbopack compiles and evaluates modules in the browser during HMR.
    scriptSrc.push('unsafe-eval');
  }

  const connectSrc = ['self', 'https://api.github.com'];
  if (isDev) {
    // The HMR socket. `ws:` covers `localhost` over plain HTTP; `wss:` covers a
    // tunnelled dev server (the repo ships an `ngrok` script).
    connectSrc.push('ws:', 'wss:');
  }

  const directives: CspDirectives = {
    'default-src': ['self'],
    'base-uri': ['self'],
    // Tailwind and the Radix primitives both set inline styles at runtime;
    // there is no nonce path for those, and a style-src bypass is not a
    // meaningful escalation on its own.
    'style-src': ['self', 'unsafe-inline'],
    'script-src': scriptSrc,
    'img-src': ['self', 'data:', 'blob:', ...imageHosts],
    'font-src': ['self', 'data:'],
    'connect-src': connectSrc,
    'media-src': ['self'],
    'worker-src': ['self', 'blob:'],
    'manifest-src': ['self'],
    // `object` and `embed` have no use in this app and are classic XSS sinks.
    'object-src': ['none'],
    // The dashboard has one-click triage (`FindingTriageControls`) and policy
    // toggles; both are clickjackable without this.
    'frame-ancestors': ['none'],
    'frame-src': ['none'],
    'form-action': ['self'],
  };

  if (!isDev) {
    // Pointless against a local HTTP dev server, and it makes `next dev`
    // rewrite localhost asset URLs to https.
    directives['upgrade-insecure-requests'] = null;
  }

  if (reportUri) directives['report-uri'] = [reportUri];

  return directives;
}

/** Convenience wrapper: build the directives and serialise them in one step. */
export function buildContentSecurityPolicy(options: SecurityHeaderOptions = {}): string {
  return serializeCspDirectives(buildCspDirectives(options));
}

/**
 * The features this app never uses.
 *
 * Denied rather than left unset so an injected iframe or a compromised
 * dependency cannot prompt a reviewer for their camera while they are reading a
 * security report.
 */
export function buildPermissionsPolicy(): string {
  return [
    'accelerometer=()',
    'ambient-light-sensor=()',
    'autoplay=()',
    'camera=()',
    'display-capture=()',
    'encrypted-media=()',
    'geolocation=()',
    'gyroscope=()',
    'interest-cohort=()',
    'magnetometer=()',
    'microphone=()',
    'midi=()',
    'payment=()',
    'publickey-credentials-get=()',
    'screen-wake-lock=()',
    'serial=()',
    'usb=()',
    'xr-spatial-tracking=()',
  ].join(', ');
}

/**
 * Build the complete header set.
 *
 * `Strict-Transport-Security` is omitted in development: committing localhost to
 * HTTPS-only for two years in the developer's browser is a genuinely annoying
 * thing to do, and it survives long after the branch is deleted.
 */
export function buildSecurityHeaders(
  options: SecurityHeaderOptions = {}
): Record<string, string> {
  const { isDev = false, reportOnly = false, apiRoute = false } = options;

  const cspHeaderName = reportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';

  const headers: Record<string, string> = {
    [cspHeaderName]: buildContentSecurityPolicy(options),

    // Redundant with `frame-ancestors 'none'` for modern browsers, kept for the
    // ones that never implemented it.
    'X-Frame-Options': 'DENY',

    // `/api/admin/export` returns CSV built from attacker-influenced repository
    // names. Sniffing that as HTML would undo the formula-injection defence in
    // src/lib/utils/csv.ts.
    'X-Content-Type-Options': 'nosniff',

    // Send the full URL same-origin (useful for our own analytics) and only the
    // origin cross-origin, so `/share/heist/<id>` paths do not leak outward.
    'Referrer-Policy': 'strict-origin-when-cross-origin',

    'Permissions-Policy': buildPermissionsPolicy(),

    // The GitHub OAuth flow opens a popup; isolating the browsing-context group
    // keeps that window from reaching back into the app.
    'Cross-Origin-Opener-Policy': 'same-origin',

    // `same-site` rather than `same-origin`: the OG image route is fetched by
    // crawlers and must stay embeddable.
    'Cross-Origin-Resource-Policy': 'same-site',

    // Legacy XSS auditor. Explicitly disabled — the auditor introduced its own
    // vulnerabilities and every current browser has removed it, but a stale
    // value in a proxy cache is worth overriding.
    'X-XSS-Protection': '0',
  };

  if (!isDev) {
    headers['Strict-Transport-Security'] =
      `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains; preload`;
  }

  if (apiRoute) {
    // API payloads contain findings and audit rows. Nothing about them should
    // sit in a shared cache.
    headers['Cache-Control'] = 'no-store, max-age=0';
  }

  return headers;
}

/** Read `CSP_REPORT_ONLY`, tolerating the usual spellings of "true". */
export function isReportOnlyEnabled(raw: string | undefined): boolean {
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

/**
 * Resolve options from the environment.
 *
 * Kept separate from the builders so the builders never read `process.env` and
 * stay trivially testable.
 */
export function securityHeaderOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SecurityHeaderOptions {
  return {
    isDev: env.NODE_ENV === 'development',
    reportOnly: isReportOnlyEnabled(env.CSP_REPORT_ONLY),
    reportUri: env.CSP_REPORT_URI?.trim() || undefined,
  };
}

/** A `headers()` entry in the shape `next.config.ts` expects. */
export interface NextHeaderRule {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

function toHeaderList(headers: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(headers).map(([key, value]) => ({ key, value }));
}

/**
 * Build the `headers()` rules for `next.config.ts`.
 *
 * Two rules, most specific first: `/api/:path*` gets the locked-down
 * `default-src 'none'` policy and `no-store`, everything else gets the document
 * policy. Next.js applies every matching rule, so the API rule's values
 * overwrite the catch-all's for the keys they share.
 */
export function buildNextSecurityHeaderRules(
  options: SecurityHeaderOptions = {}
): NextHeaderRule[] {
  return [
    {
      source: '/api/:path*',
      headers: toHeaderList(buildSecurityHeaders({ ...options, apiRoute: true })),
    },
    {
      source: '/:path*',
      headers: toHeaderList(buildSecurityHeaders({ ...options, apiRoute: false })),
    },
  ];
}

/** Minimal structural type so this module does not import `next/server`. */
export interface HeaderBearingResponse {
  headers: { set(name: string, value: string): void };
}

/**
 * Attach the header set to a response object in place, and return it.
 *
 * Used by `src/proxy.ts` for the responses middleware builds itself. Existing
 * values are overwritten: middleware is the last writer for those responses, so
 * a partially-populated header is not something we want to preserve.
 */
export function applySecurityHeaders<T extends HeaderBearingResponse>(
  response: T,
  options: SecurityHeaderOptions = {}
): T {
  for (const [key, value] of Object.entries(buildSecurityHeaders(options))) {
    response.headers.set(key, value);
  }
  return response;
}
