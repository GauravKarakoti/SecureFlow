/**
 * POST /api/findings — Enqueue an async vulnerability scan.
 *
 * Accepts scan parameters and enqueues a background job instead of
 * running the scan synchronously. Returns immediately with a job ID
 * that can be polled via /api/findings/status/[jobId].
 *
 * This prevents HTTP gateway timeouts (504) on large repositories
 * by offloading the scan to a Redis-backed BullMQ worker pool.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withErrorHandler, AppError } from '@/lib/middleware/error-handler';
import { withRateLimit } from '@/lib/middleware/rate-limit';
import { enqueueScan, type ScanJobData } from '@/lib/queue/scanQueue';
import { z } from 'zod';

const scanRequestSchema = z.object({
  repositoryId: z.string(),
  installationId: z.union([z.number(), z.string()]),
  repositoryFullName: z.string(),
  prNumber: z.number(),
  headSha: z.string(),
  fileChanges: z.array(z.object({
    filename: z.string(),
    patch: z.string(),
  })).default([]),
  activePolicies: z.array(z.object({
    description: z.string(),
  }).passthrough()).default([]),
  customIgnores: z.array(z.string()).default([]),
  customPlaceholders: z.array(z.string()).default([]),
  userId: z.string().optional(),
});

const handler = withErrorHandler(async function POST(req: NextRequest) {
  const body = await req.json();

  const parsed = scanRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(
      `Invalid scan request: ${parsed.error.issues.map(i => i.message).join(', ')}`,
      400
    );
  }

  const data: ScanJobData = {
    scanJobId: '', // Will be set by enqueueScan
    ...parsed.data,
    installationId: parsed.data.installationId,
  };

  const { jobId, scanJobId } = await enqueueScan(data);

  return NextResponse.json({
    status: 'queued',
    jobId,
    scanJobId,
    message: 'Scan job enqueued successfully',
    pollingUrl: `/api/findings/status/${scanJobId}`,
  }, { status: 202 });
});

export const POST = withRateLimit(handler, {
  limit: 10,
  windowSeconds: 60,
  keyPrefix: 'findings:scan',
});

export const dynamic = 'force-dynamic';
