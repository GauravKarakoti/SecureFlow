import { type NextRequest, NextResponse } from "next/server";
import { getDetailedLandingMetrics } from "@/lib/metrics/landing-stats";
import { DEFAULT_METRICS_TTL_MS, createTtlCache } from "@/lib/metrics/landing-cache";
import { TIERS, withRateLimit } from "@/lib/middleware/rate-limit";

export const dynamic = "force-dynamic";

/** Seconds a cached metrics response stays servable, for the header and the cache. */
export const METRICS_CACHE_SECONDS = DEFAULT_METRICS_TTL_MS / 1000;

/**
 * Process-wide cache for the landing metrics.
 *
 * This endpoint is public, unauthenticated and `force-dynamic`, and each call
 * to `getDetailedLandingMetrics` fans out into `COUNT(*)` aggregates over the
 * four largest tables in the schema. The `s-maxage` header below is honoured by
 * a CDN if one sits in front, and by nothing at all if one does not —
 * `force-dynamic` guarantees the framework will not cache it. So that header
 * was the only thing between an anonymous `while true; do curl; done` and the
 * database (#705).
 *
 * The cache also collapses concurrent misses onto a single in-flight query, so
 * the moment the entry expires under load does not turn into one full fan-out
 * per waiting request. See `@/lib/metrics/landing-cache`.
 *
 * Wrapped in an arrow rather than passed by reference so the call resolves
 * through the module binding each time, which keeps the function mockable in
 * tests.
 */
const metricsCache = createTtlCache(() => getDetailedLandingMetrics(), {
  ttlMs: DEFAULT_METRICS_TTL_MS,
});

/** Drop the cached metrics. Test seam, and useful after a seed or a reset. */
export function resetLandingMetricsCache(): void {
  metricsCache.invalidate();
}

async function handler(_req: NextRequest): Promise<NextResponse> {
  try {
    // Read before the load, or every response would report a hit — `get()`
    // populates the entry it is being asked about.
    const wasCached = metricsCache.peek() !== null;
    const metrics = await metricsCache.get();

    return NextResponse.json(metrics, {
      status: 200,
      headers: {
        "Cache-Control": `public, s-maxage=${METRICS_CACHE_SECONDS}, stale-while-revalidate=300`,
        // Stated rather than implied, so a caller can tell a fresh computation
        // from a cached one without inferring it from timing.
        "X-Metrics-Cache": wasCached ? "hit" : "miss",
      },
    });
  } catch (error) {
    console.error("[API Metrics Landing] Error fetching metrics:", error);
    return NextResponse.json({ error: "Failed to retrieve security metrics" }, { status: 500 });
  }
}

/**
 * Rate-limited like every other route in the application.
 *
 * This was the only handler under `src/app/api` exporting a bare `GET` with no
 * wrapper at all. `STANDARD` is the right tier: it is a read of public data,
 * and it fails open, so a Redis outage cannot take the landing page down with
 * it.
 */
export const GET = withRateLimit(handler, {
  ...TIERS.STANDARD,
  keyPrefix: "metrics:landing",
});
