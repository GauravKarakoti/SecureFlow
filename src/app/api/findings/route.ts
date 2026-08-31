/**
 * POST /api/findings — Enqueue an async vulnerability scan.
 *
 * Accepts scan parameters and enqueues a background job instead of
 * running the scan synchronously. Returns immediately with a job ID
 * that can be polled via /api/findings/status/[jobId].
 *
 * This prevents HTTP gateway timeouts (504) on large repositories
 * by offloading the scan to a Redis-backed BullMQ worker pool.
 *
 * The route requires a session and a repository the session user owns (#748).
 * Before that it was anonymous, and `repositoryFullName`, `prNumber`,
 * `repositoryId` and `userId` all came from the request body — enough for an
 * unauthenticated caller to make the GitHub App post a check run and a comment
 * on any pull request in any installation, and to choose whose id appeared on
 * the resulting audit row.
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { withErrorHandler, AppError } from '@/lib/middleware/error-handler';
import { withRateLimit } from '@/lib/middleware/rate-limit';
import { enqueueScan } from '@/lib/queue/scanQueue';
import {
  buildScanJobData,
  loadOwnedRepository,
  scanRequestSchema,
} from '@/lib/findings/scan-authorization';

/** Never cached: a POST result, and a per-user job handle. */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

const handler = withErrorHandler(async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new AppError('Unauthorized', 401);
  }
  const userId = session.user.id;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError('Request body is not valid JSON', 400);
  }

  const parsed = scanRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(
      `Invalid scan request: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      400
    );
  }

  // Scoped to the session user, so a repository belonging to someone else is
  // indistinguishable from one that does not exist — the same shape as
  // `setFindingStatus`. Everything the scan aims at GitHub is read off this row
  // rather than off the request.
  const repository = await loadOwnedRepository(
    prisma.repository as never,
    parsed.data.repositoryId,
    userId
  );

  if (!repository) {
    throw new AppError('Repository not found', 404);
  }

  const { jobId, scanJobId } = await enqueueScan(
    buildScanJobData({ body: parsed.data, repository, userId })
  );

  return NextResponse.json(
    {
      status: 'queued',
      jobId,
      scanJobId,
      message: 'Scan job enqueued successfully',
      pollingUrl: `/api/findings/status/${scanJobId}`,
    },
    { status: 202, headers: NO_STORE }
  );
});

export const POST = withRateLimit(handler, {
  limit: 10,
  windowSeconds: 60,
  keyPrefix: 'findings:scan',
});

export const dynamic = 'force-dynamic';
