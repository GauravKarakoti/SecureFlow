import { type NextRequest, NextResponse } from "next/server";
import { getDetailedLandingMetrics } from "@/lib/metrics/landing-stats";
import { DEFAULT_METRICS_TTL_MS, createTtlCache } from "@/lib/metrics/landing-cache";
import { TIERS, withRateLimit } from "@/lib/middleware/rate-limit";
import { withErrorHandler } from "@/lib/middleware/error-handler";
import { formatPrometheusMetrics, PROMETHEUS_CONTENT_TYPE } from "@/lib/metrics/prometheus";

export const dynamic = "force-dynamic";

/** Seconds a cached metrics response stays servable, for the header and the cache. */
export const METRICS_CACHE_SECONDS = DEFAULT_METRICS_TTL_MS / 1000;

/**
 * Process-wide cache for metrics.
 *
 * Caches and collapses concurrent misses onto a single in-flight query to protect
 * the database from scrape storms.
 */
const metricsCache = createTtlCache(() => getDetailedLandingMetrics(), {
  ttlMs: DEFAULT_METRICS_TTL_MS,
});

/** Drop the cached metrics. Test seam, and useful after a seed or a reset. */
export function resetMetricsCache(): void {
  metricsCache.invalidate();
}

async function handler(req: NextRequest): Promise<NextResponse> {
  try {
    const wasCached = metricsCache.peek() !== null;
    const metrics = await metricsCache.get();

    const accept = req.headers.get("accept") || "";
    const format = req.nextUrl?.searchParams?.get("format");
    const wantsJson =
      format === "json" ||
      (accept.includes("application/json") &&
        !accept.includes("text/plain") &&
        !accept.includes("application/openmetrics-text"));

    if (wantsJson) {
      return NextResponse.json(metrics, {
        status: 200,
        headers: {
          "Cache-Control": `public, s-maxage=${METRICS_CACHE_SECONDS}, stale-while-revalidate=300`,
          "X-Metrics-Cache": wasCached ? "hit" : "miss",
        },
      });
    }

    return new NextResponse(formatPrometheusMetrics(metrics), {
      status: 200,
      headers: {
        "Content-Type": PROMETHEUS_CONTENT_TYPE,
        "Cache-Control": `public, s-maxage=${METRICS_CACHE_SECONDS}, stale-while-revalidate=300`,
        "X-Metrics-Cache": wasCached ? "hit" : "miss",
      },
    });
  } catch (error) {
    console.error("[API Metrics] Error fetching metrics:", error);
    return NextResponse.json({ error: "Failed to retrieve metrics" }, { status: 500 });
  }
}

/**
 * Rate-limited metrics endpoint.
 * Returns Prometheus text exposition by default, or JSON when requested.
 */
export const GET = withRateLimit(
  withErrorHandler(handler, { routeLabel: "metrics:prometheus" }) as (
    req: NextRequest,
  ) => Promise<NextResponse>,
  {
    ...TIERS.STANDARD,
    keyPrefix: "metrics:prometheus",
  },
);
