import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import {
  API_RATE_LIMIT_TIERS,
  type ApiRateLimitTier,
  type LimitedApiRateLimitClass,
} from "./api-rate-limit-policy";

/**
 * Whether a distributed limiter is available at all.
 *
 * Without Upstash configured there is nothing to count against, and the
 * middleware skips limiting rather than failing every request.
 */
function upstashConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL);
}

/**
 * The original single global limiter.
 *
 * Kept so anything importing `ratelimit` keeps working. New code should use
 * {@link getApiRateLimiter}, which gives each class of API traffic its own
 * budget instead of putting webhook deliveries, OAuth callbacks and dashboard
 * fetches in one bucket (#644).
 */
export const ratelimit = upstashConfigured()
  ? new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(20, "60 s"),
    })
  : null;

/**
 * One limiter per class, built on first use.
 *
 * Memoised because constructing a `Ratelimit` opens a REST client and the
 * middleware runs on every request. Keyed by class rather than by tier object,
 * so a config change cannot silently produce two limiters sharing a prefix.
 */
const limiters = new Map<LimitedApiRateLimitClass, Ratelimit>();

function buildLimiter(tier: ApiRateLimitTier): Ratelimit {
  return new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(tier.limit, `${tier.windowSeconds} s`),
    // A distinct prefix per class is the whole point: sharing one would put the
    // classes straight back into a single bucket.
    prefix: tier.keyPrefix,
  });
}

/** Resolve the limiter for a class, or `null` when Upstash is not configured. */
export function getApiRateLimiter(className: LimitedApiRateLimitClass): Ratelimit | null {
  if (!upstashConfigured()) return null;

  const existing = limiters.get(className);
  if (existing) return existing;

  const limiter = buildLimiter(API_RATE_LIMIT_TIERS[className]);
  limiters.set(className, limiter);
  return limiter;
}

/** Drop the memoised limiters. Test seam. */
export function resetApiRateLimiters(): void {
  limiters.clear();
}
