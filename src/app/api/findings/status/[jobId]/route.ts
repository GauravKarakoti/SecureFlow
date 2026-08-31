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
 */

import { NextRequest, NextResponse } from 'next/server';
import { withErrorHandler, AppError } from '@/lib/middleware/error-handler';
import { getScanJobStatus } from '@/lib/queue/scanQueue';

const handler = withErrorHandler(async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  if (!jobId || typeof jobId !== 'string') {
    throw new AppError('Invalid job ID', 400);
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

export const GET = handler;
export const dynamic = 'force-dynamic';
