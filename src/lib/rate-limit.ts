import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import {
  API_RATE_LIMIT_TIERS,
  API_USER_RATE_LIMIT_TIERS,
  type ApiRateLimitTier,
  type LimitedApiRateLimitClass,
  type RateLimitDecision,
} from "./api-rate-limit-policy";
import { checkRateLimitDetailed, type FallbackStrategy } from "./redis";

export interface RateLimiterLike {
  limit(identifier: string): Promise<RateLimitDecision>;
}

export type RateLimitScope = "ip" | "user";

/**
 * Whether Upstash REST client is configured.
 */
function upstashConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL);
}

/**
 * A rate limiter backed by the application's Redis infrastructure (src/lib/redis.ts)
 * with bounded in-memory fallback.
 */
export class RedisApiRateLimiter implements RateLimiterLike {
  constructor(
    private tier: ApiRateLimitTier,
    private fallbackStrategy: FallbackStrategy = "fail-closed",
  ) {}

  async limit(identifier: string): Promise<RateLimitDecision> {
    const key = `api-rate-limit:${this.tier.keyPrefix}:${identifier}`;
    const result = await checkRateLimitDetailed(key, this.tier.limit, this.tier.windowSeconds, {
      fallbackStrategy: this.fallbackStrategy,
      timeoutMs: 1000,
    });

    return {
      success: result.allowed,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.resetAt,
    };
  }
}

/**
 * The single global limiter.
 *
 * Kept so legacy imports keep working. Utilizes Redis infrastructure when
 * Upstash is not configured.
 */
export const ratelimit: RateLimiterLike = upstashConfigured()
  ? new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(20, "60 s"),
    })
  : new RedisApiRateLimiter({ limit: 20, windowSeconds: 60, keyPrefix: "global" }, "fail-closed");

/**
 * Limiters memoised per (class, scope).
 */
const limiters = new Map<string, RateLimiterLike>();

function buildUpstashLimiter(tier: ApiRateLimitTier): Ratelimit {
  return new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(tier.limit, `${tier.windowSeconds} s`),
    prefix: tier.keyPrefix,
  });
}

/**
 * Resolve the limiter for an API class and scope (IP or user).
 *
 * Utilizes existing Redis infrastructure (helm/secureflow/templates/redis-statefulset.yaml)
 * when Upstash REST is not configured, ensuring rate limiting is always enforced.
 */
export function getApiRateLimiter(
  className: LimitedApiRateLimitClass,
  scope: RateLimitScope = "ip",
): RateLimiterLike {
  const cacheKey = `${className}:${scope}`;
  const existing = limiters.get(cacheKey);
  if (existing) return existing;

  const tier =
    scope === "user" ? API_USER_RATE_LIMIT_TIERS[className] : API_RATE_LIMIT_TIERS[className];

  let limiter: RateLimiterLike;
  if (upstashConfigured() && scope === "ip") {
    limiter = buildUpstashLimiter(tier);
  } else {
    const fallbackStrategy: FallbackStrategy =
      className === "standard" && scope === "ip" ? "fail-open" : "fail-closed";
    limiter = new RedisApiRateLimiter(tier, fallbackStrategy);
  }

  limiters.set(cacheKey, limiter);
  return limiter;
}

/** Drop the memoised limiters. Test seam. */
export function resetApiRateLimiters(): void {
  limiters.clear();
}
