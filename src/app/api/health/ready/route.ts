import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { redis } from '@/lib/queue/redis';
import { webhookQueue } from '@/lib/queue/webhookQueue';
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  databaseProbe,
  queueProbe,
  redisProbe,
  runCheck,
  statusCodeFor,
  summarize,
  type CheckResult,
} from '@/lib/health/checks';

/**
 * GET /api/health/ready — readiness.
 *
 * Verifies the dependencies the app cannot function without, so an orchestrator
 * can stop routing traffic to an instance that will accept requests and then
 * fail to do anything useful with them. Returns 503 when a required dependency
 * is down, 200 otherwise.
 *
 * Checks run concurrently, each under its own timeout, so one hung socket cannot
 * hang the probe.
 */
export const dynamic = 'force-dynamic';

/**
 * Dependencies that gate readiness.
 *
 * The queue depth check is deliberately absent: a deep backlog means the
 * instance is behind, not broken, and shedding it from rotation would only make
 * the backlog worse. It is reported as `degraded` and still answers 200.
 */
const REQUIRED_CHECKS = ['database', 'redis'];

export async function GET() {
  // The mock-DB fixture used for local UI work has no real Postgres or Redis
  // behind it, so probing them would report a permanent outage that is not one.
  const mocked = process.env.NEXT_PUBLIC_MOCK_DB === 'true';

  const checks: CheckResult[] = mocked
    ? [
        { name: 'database', status: 'skipped', durationMs: 0, detail: 'mock mode' },
        { name: 'redis', status: 'skipped', durationMs: 0, detail: 'mock mode' },
        { name: 'queue', status: 'skipped', durationMs: 0, detail: 'mock mode' },
      ]
    : await Promise.all([
        runCheck('database', databaseProbe(prisma), DEFAULT_CHECK_TIMEOUT_MS),
        runCheck('redis', redisProbe(redis), DEFAULT_CHECK_TIMEOUT_MS),
        runCheck('queue', queueProbe(webhookQueue), DEFAULT_CHECK_TIMEOUT_MS),
      ]);

  const report = summarize(checks, REQUIRED_CHECKS);

  return NextResponse.json(
    { ...report, timestamp: new Date().toISOString() },
    {
      status: statusCodeFor(report),
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    }
  );
}
