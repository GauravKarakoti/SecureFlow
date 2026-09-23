/**
 * GET /api/sbom/scan/status/[jobId] — Poll SBOM scan job progress.
 *
 * Returns the current lifecycle status (PENDING, PROCESSING, COMPLETED, FAILED)
 * and the final SbomScanResult once the worker has finished processing.
 *
 * Scoped to the session user — jobs belonging to other users report 404 (not found)
 * to avoid leaking job existence.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import { getSbomJobStatus } from "@/lib/queue/sbomQueue";

const handler = withErrorHandler(async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new AppError("Unauthorized", 401);
  }
  const userId = session.user.id;

  const { jobId } = await params;
  if (!jobId || typeof jobId !== "string") {
    throw new AppError("Invalid job ID", 400);
  }

  // 1. Check ScanJob existence
  const scanJob = await prisma.scanJob.findUnique({
    where: { id: jobId },
    select: { id: true, repositoryId: true },
  });

  if (!scanJob) {
    throw new AppError("Scan job not found", 404);
  }

  // 2. Authorization check: ensure caller owns this scan
  let authorized = false;

  if (scanJob.repositoryId) {
    const repo = await prisma.repository.findFirst({
      where: { id: scanJob.repositoryId, userId },
      select: { id: true },
    });
    authorized = Boolean(repo);
  } else {
    // For standalone manifest scans without a repository, check the enqueuing AuditLog
    const enqueuedAudit = await prisma.auditLog.findFirst({
      where: {
        userId,
        resource: jobId,
        action: "SBOM SCAN ENQUEUED",
      },
      select: { id: true },
    });
    authorized = Boolean(enqueuedAudit);
  }

  if (!authorized) {
    // Return 404 rather than 403 to prevent existence discovery
    throw new AppError("Scan job not found", 404);
  }

  // 3. Retrieve status & results
  const statusInfo = await getSbomJobStatus(jobId);
  if (!statusInfo) {
    throw new AppError("Scan job not found", 404);
  }

  return NextResponse.json(statusInfo, {
    status: 200,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    },
  });
});

export const GET = withRateLimit(handler, {
  ...TIERS.STANDARD,
  keyPrefix: "sbom:status",
});

export const dynamic = "force-dynamic";
