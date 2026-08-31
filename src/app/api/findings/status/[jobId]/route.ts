/**
 * GET /api/findings/status/[jobId] — Poll scan job progress.
 *
 * Returns the current status, progress percentage, and results
 * of a vulnerability scan job. Clients poll this endpoint to track
 * scan progress in real-time.
 *
 * Response includes:
 * - status: PENDING | PROCESSING | COMPLETED | FAILED
 * - progress: 0-100 percentage
 * - scannedFiles / totalFiles counts
 * - vulnerabilitiesFound count
 * - riskScore and policyDecision (when completed)
 * - error message (when failed)
 *
 * Requires a session, and only answers for a job whose repository belongs to the
 * caller (#748). Previously the only guard was knowing the id: the route had no
 * `auth()` call and no ownership check, so anyone holding a job id could read
 * another account's risk score, policy decision and failure message. Ids are
 * cuids, but "unguessable identifier" is not an authorization model, and they
 * are handed out in the POST response and appear in logs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { withErrorHandler, AppError } from '@/lib/middleware/error-handler';
import { withRateLimit, TIERS } from '@/lib/middleware/rate-limit';
import { getScanJobStatus } from '@/lib/queue/scanQueue';
import {
  loadScanJobOwnership,
  scanJobVisibility,
} from '@/lib/findings/scan-authorization';

const handler = withErrorHandler(async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new AppError('Unauthorized', 401);
  }

  const { jobId } = await params;

  if (!jobId || typeof jobId !== 'string') {
    throw new AppError('Invalid job ID', 400);
  }

  // Ownership first, and a job the caller does not own is reported as absent
  // rather than forbidden — distinguishing the two would make this endpoint an
  // oracle for "does this job id exist", which is most of what id-guessing
  // wants, and the caller has no legitimate use for the difference.
  const ownership = await loadScanJobOwnership(prisma.scanJob as never, jobId);
  if (scanJobVisibility(ownership, session.user.id) !== 'visible') {
    throw new AppError('Scan job not found', 404);
  }

  const status = await getScanJobStatus(jobId);

  if (!status) {
    throw new AppError('Scan job not found', 404);
  }

  return NextResponse.json(status, {
    status: 200,
    headers: {
      // Allow polling from the frontend
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    },
  });
});

// Polling was previously unbounded at the route layer — the sibling POST is
// wrapped and this one was not.
//
// `withRateLimit` takes `(req, ...args: any[])`, which a two-parameter route
// handler satisfies, so no cast is needed here — and none is wanted: casting
// the export to `never` makes it uncallable from a test, which is precisely
// where this route needed covering.
export const GET = withRateLimit(handler, {
  ...TIERS.STANDARD,
  keyPrefix: 'findings:status',
});

export const dynamic = 'force-dynamic';
