import { NextResponse } from 'next/server';

/**
 * GET /api/health — liveness.
 *
 * Answers one question: is this process serving HTTP? It performs no I/O, so it
 * cannot be made slow or made to fail by a database or Redis outage, which is
 * exactly what a liveness probe needs. Use `/api/health/ready` when the question
 * is whether the instance should receive traffic.
 *
 * This is what the keep-alive workflow and the container `HEALTHCHECK` should
 * hit. The previous keep-alive step curled the site root, discarded the status
 * code and appended `|| true`, so it could never detect an outage — it only kept
 * the dyno warm.
 */
export const dynamic = 'force-dynamic';

/** Captured at module load, so the value is the process start rather than the request time. */
const STARTED_AT = Date.now();

export async function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      // Surfaced so a deploy can be identified from the probe alone. Both are
      // build-time values and neither is a secret; when unset they are simply
      // absent rather than guessed at.
      version: process.env.npm_package_version ?? null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? null,
      timestamp: new Date().toISOString(),
    },
    {
      status: 200,
      headers: {
        // A cached health check is a health check for whenever the cache was
        // populated, which is worse than none.
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    }
  );
}
