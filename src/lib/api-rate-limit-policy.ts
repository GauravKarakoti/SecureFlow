/**
 * Which rate limit applies to which `/api` path (#644).
 *
 * `src/proxy.ts` ran every `/api` request through one 20-per-60s bucket keyed on
 * client IP. Two of the paths caught by that bucket must not be in it:
 *
 *  - **`/api/webhooks/github`.** GitHub delivers from a small pool of source
 *    addresses, so every hook for every installation collapses onto a handful of
 *    IP keys. Twenty pull-request events in a minute — a merge train, a bot
 *    pushing to several PRs, an `installation_repositories` burst after an app
 *    install — and the twenty-first gets a 429. GitHub records the delivery as
 *    failed and does not retry a 4xx. The scan is lost, silently.
 *
 *    It is also the wrong control for that route: the endpoint is authenticated
 *    by HMAC signature and deduplicated on `x-github-delivery`. It is not an
 *    anonymous surface that needs an IP bucket in front of it.
 *
 *  - **`/api/auth/*`.** `/api/auth/session` is polled by the client and
 *    `/api/auth/callback/github` is the OAuth return leg. On a shared egress IP
 *    — an office, a university lab, a corporate VPN, which is exactly where a
 *    team of reviewers sits — twenty requests a minute across *all* users behind
 *    that NAT is not much. When it trips mid-callback the user gets a JSON 429
 *    where the OAuth redirect should have been, which reads as "login is
 *    broken".
 *
 * Classification is a pure function of the pathname so it can be tested without
 * standing up a request, a Redis, or a NextAuth session.
 */

/**
 * Rate-limit class for an API path.
 *
 * `exempt` means "not limited *here*" — not "unlimited". Exempt routes carry
 * their own controls (an HMAC signature, a route-level `withRateLimit`); what
 * they must not have is a blanket IP bucket shared with unrelated traffic.
 */
export type ApiRateLimitClass = 'exempt' | 'auth' | 'stream' | 'standard';

export interface ApiRateLimitTier {
  /** Requests permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * Redis key prefix.
   *
   * Distinct per class on purpose: sharing a prefix would put the classes back
   * in one bucket, which is the bug this module exists to fix.
   */
  keyPrefix: string;
}

export type LimitedApiRateLimitClass = Exclude<ApiRateLimitClass, 'exempt'>;

/**
 * Default budgets per class.
 *
 * `standard` keeps the previous global number so nothing that was working stops
 * working. `auth` is deliberately generous — session polling is cheap and a
 * shared NAT multiplies it — and `stream` is tighter because those routes cost
 * a model completion each.
 */
export const API_RATE_LIMIT_TIERS: Readonly<Record<LimitedApiRateLimitClass, ApiRateLimitTier>> = {
  auth: { limit: 60, windowSeconds: 60, keyPrefix: 'api:auth' },
  stream: { limit: 20, windowSeconds: 60, keyPrefix: 'api:stream' },
  standard: { limit: 20, windowSeconds: 60, keyPrefix: 'api:standard' },
};

/**
 * Paths with their own authentication or their own limiter.
 *
 * Matched as a prefix on a normalised pathname.
 */
export const EXEMPT_PREFIXES: readonly string[] = [
  // HMAC-signed and delivery-deduplicated; see src/app/api/webhooks/github.
  '/api/webhooks',
  // Liveness and readiness probes. A platform health check that gets 429'd is
  // read as an outage, which is the opposite of what the probe is for.
  '/api/health',
  '/api/ready',
];

/** NextAuth's routes. */
export const AUTH_PREFIX = '/api/auth';

/**
 * Routes that hold a connection open and cost a model completion.
 *
 * These already carry a route-level `withRateLimit` from `TIERS.AI_STREAM`. The
 * class exists so the middleware's decision matches rather than silently
 * overriding it with whichever number happens to be stricter.
 */
export const STREAM_PREFIXES: readonly string[] = [
  '/api/heist-transmission',
  '/api/og/heist',
];

/** Suffix of an AI streaming route under `/api/findings/[id]/`. */
const FINDINGS_STREAM_SUFFIX = '/explain-stream';

/**
 * Normalise a pathname before matching.
 *
 * Lower-cased and stripped of a trailing slash, and collapsed on repeated
 * slashes. Without this, `/API/Webhooks//github/` is a different string from
 * `/api/webhooks/github` and would fall through to the default class — which
 * for an exemption is a bypass in the wrong direction.
 */
export function normalizeApiPath(pathname: string): string {
  if (!pathname) return '';
  const collapsed = pathname.replace(/\/{2,}/g, '/').toLowerCase();
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

/** True when a path is under `/api`. */
export function isApiPath(pathname: string): boolean {
  const normalized = normalizeApiPath(pathname);
  return normalized === '/api' || normalized.startsWith('/api/');
}

function matchesPrefix(normalized: string, prefix: string): boolean {
  return normalized === prefix || normalized.startsWith(`${prefix}/`);
}

/**
 * Decide which limit applies to a path.
 *
 * Anything outside `/api` is `exempt`: the middleware only ever limited `/api`,
 * and page routes are served from the cache far more often than they reach a
 * function.
 */
export function classifyApiPath(pathname: string): ApiRateLimitClass {
  const normalized = normalizeApiPath(pathname);

  if (!isApiPath(normalized)) return 'exempt';

  if (EXEMPT_PREFIXES.some((prefix) => matchesPrefix(normalized, prefix))) {
    return 'exempt';
  }

  if (matchesPrefix(normalized, AUTH_PREFIX)) return 'auth';

  if (
    STREAM_PREFIXES.some((prefix) => matchesPrefix(normalized, prefix)) ||
    normalized.endsWith(FINDINGS_STREAM_SUFFIX)
  ) {
    return 'stream';
  }

  return 'standard';
}

/** Resolve the tier for a path, or `null` when the path is not limited here. */
export function tierForPath(pathname: string): ApiRateLimitTier | null {
  const classification = classifyApiPath(pathname);
  return classification === 'exempt' ? null : API_RATE_LIMIT_TIERS[classification];
}

/**
 * The parts of an Upstash `limit()` result this module needs.
 *
 * Structural rather than an import so the header helpers can be unit-tested
 * without constructing a `Ratelimit`.
 */
export interface RateLimitDecision {
  success: boolean;
  limit: number;
  remaining: number;
  /** Epoch milliseconds at which the window rolls over. */
  reset: number;
}

/**
 * Seconds until the window rolls over, floored at 1.
 *
 * Mirrors `secondsUntilReset` in `src/lib/middleware/rate-limit.ts`. Duplicated
 * rather than imported because that module pulls in the Redis client, and the
 * middleware runs on every request including the ones that will not be limited
 * at all.
 */
export function retryAfterSeconds(reset: number, now: number = Date.now()): number {
  if (!Number.isFinite(reset)) return 1;
  return Math.max(1, Math.ceil((reset - now) / 1000));
}

/**
 * The standard rate-limit headers for a decision.
 *
 * The middleware's 429 previously carried none of these, while `withRateLimit`
 * on the route handlers emitted all four. A client cannot back off correctly
 * against a limiter that will not say when the window rolls over, and the two
 * paths disagreeing about it is worse than either alone.
 *
 * `X-RateLimit-Reset` is epoch seconds, matching the GitHub API convention this
 * project already talks to.
 */
export function rateLimitHeaders(
  decision: RateLimitDecision,
  now: number = Date.now()
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(decision.limit),
    'X-RateLimit-Remaining': String(Math.max(0, decision.remaining)),
    'X-RateLimit-Reset': String(Math.ceil(decision.reset / 1000)),
  };

  if (!decision.success) {
    headers['Retry-After'] = String(retryAfterSeconds(decision.reset, now));
  }

  return headers;
}
