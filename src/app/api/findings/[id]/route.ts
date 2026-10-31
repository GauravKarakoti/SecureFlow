/**
 * GET /api/findings/[id]     — Fetch single finding with full detail
 * PATCH /api/findings/[id]   — Update triage status and/or severity
 * DELETE /api/findings/[id]  — Delete a finding (owner only)
 *
 * All operations scope to the authenticated session user via the relation chain:
 * Finding → ScanResult → PullRequest → Repository → userId.
 * A finding the caller does not own is indistinguishable from one that does
 * not exist (404), preventing IDOR enumeration attacks.
 *
 * Implements Issue #1465.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import {
  withRateLimit,
  TIERS,
  buildRateLimitHeaders,
  secondsUntilReset,
} from "@/lib/middleware/rate-limit";
import { checkRateLimitDetailed } from "@/lib/redis";
import { isTriageStatus, type TriageStatus } from "@/lib/triage/statuses";
import type { FindingSeverity } from "@prisma/client";

export const dynamic = "force-dynamic";

/** Allowed severity values on the Finding model. */
const VALID_SEVERITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]);

/** Fields selected for every GET response. */
const FINDING_SELECT = {
  id: true,
  type: true,
  severity: true,
  fileLocation: true,
  lineStart: true,
  lineEnd: true,
  codeSnippet: true,
  explanation: true,
  remediation: true,
  promptInjectionSuspected: true,
  fingerprint: true,
  complianceTags: true,
  createdAt: true,
  remediationPatch: {
    select: {
      id: true,
      patchDiff: true,
      status: true,
      createdAt: true,
    },
  },
  scanResult: {
    select: {
      id: true,
      riskScore: true,
      policyDecision: true,
      createdAt: true,
      pullRequest: {
        select: {
          id: true,
          prNumber: true,
          title: true,
          state: true,
          repositoryId: true,
        },
      },
    },
  },
} as const;

/**
 * Resolve the authenticated user's ID, throwing AppError 401 if unauthenticated.
 */
async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new AppError("Unauthorized", 401);
  }
  return session.user.id;
}

/**
 * Fetch a finding scoped to the session user.
 * Returns null when not found or not owned — both map to 404.
 */
async function findOwnedFinding(id: string, userId: string) {
  return prisma.finding.findFirst({
    where: {
      id,
      scanResult: {
        pullRequest: {
          repository: { userId },
        },
      },
    },
    select: FINDING_SELECT,
  });
}

// ─── GET ──────────────────────────────────────────────────────────────────────

const getHandler = withErrorHandler(async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await requireUserId();
  const { id } = await params;

  const finding = await findOwnedFinding(id, userId);
  if (!finding) {
    throw new AppError("Finding not found", 404);
  }

  return NextResponse.json(finding, {
    status: 200,
    headers: { "Cache-Control": "private, no-store" },
  });
});

// ─── PATCH ────────────────────────────────────────────────────────────────────

/**
 * PATCH body shape.
 * Both fields are optional — a PATCH with only `severity` is valid.
 */
interface PatchFindingBody {
  triageStatus?: string;
  severity?: string;
  note?: string | null;
}

const patchHandler = withErrorHandler(async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await requireUserId();

  // Per-user rate limit to prevent rapid automated triage bursts
  const userLimit = await checkRateLimitDetailed(
    `rate-limit:findings:patch:user:${userId}`,
    TIERS.STANDARD.limit,
    TIERS.STANDARD.windowSeconds,
    { fallbackStrategy: TIERS.STANDARD.fallbackStrategy },
  );
  if (!userLimit.allowed) {
    return NextResponse.json(
      { error: "Too Many Requests", message: "Rate limit exceeded. Please slow down." },
      {
        status: 429,
        headers: {
          ...buildRateLimitHeaders(userLimit),
          "Retry-After": String(secondsUntilReset(userLimit.resetAt)),
        },
      },
    );
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError("Request body is not valid JSON", 400);
  }

  const { triageStatus, severity, note } = body as PatchFindingBody;

  // At least one update field must be present
  if (triageStatus === undefined && severity === undefined) {
    throw new AppError("At least one of triageStatus or severity must be provided", 400);
  }

  // Validate triageStatus
  if (triageStatus !== undefined && !isTriageStatus(triageStatus)) {
    throw new AppError(
      `Invalid triageStatus. Allowed values: OPEN, RESOLVED, FALSE_POSITIVE, IGNORED`,
      400,
    );
  }

  // Validate severity
  if (severity !== undefined && !VALID_SEVERITIES.has(severity)) {
    throw new AppError(
      `Invalid severity. Allowed values: CRITICAL, HIGH, MEDIUM, LOW, INFO`,
      400,
    );
  }

  // Verify ownership before any mutation
  const existing = await prisma.finding.findFirst({
    where: {
      id,
      scanResult: { pullRequest: { repository: { userId } } },
    },
    select: {
      id: true,
      fingerprint: true,
      scanResult: { select: { pullRequest: { select: { repositoryId: true } } } },
    },
  });
  if (!existing) {
    throw new AppError("Finding not found", 404);
  }

  // Apply severity update directly on the Finding row
  if (severity !== undefined) {
    await prisma.finding.update({
      where: { id },
      data: { severity: severity as FindingSeverity },
      select: { id: true },
    });
  }

  // Apply triage status via the FindingTriage upsert pattern
  if (triageStatus !== undefined) {
    const repositoryId = existing.scanResult.pullRequest.repositoryId;
    const fingerprint = existing.fingerprint;
    const cleanNote = note?.trim() ? note.trim() : null;
    await prisma.findingTriage.upsert({
      where: { repositoryId_fingerprint: { repositoryId, fingerprint } },
      update: {
        status: triageStatus as TriageStatus,
        note: cleanNote,
        resolvedById: userId,
      },
      create: {
        repositoryId,
        fingerprint,
        status: triageStatus as TriageStatus,
        note: cleanNote,
        resolvedById: userId,
      },
    });
  }

  await prisma.auditLog.create({
    data: {
      userId,
      action: "finding.patch",
      resource: `finding:${id}`,
      decision: "ALLOW",
      metadata: { triageStatus, severity, note },
    },
  });

  const updated = await findOwnedFinding(id, userId);
  return NextResponse.json(updated, { status: 200 });
});

// ─── DELETE ───────────────────────────────────────────────────────────────────

const deleteHandler = withErrorHandler(async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await requireUserId();

  // Per-user rate limit for deletions
  const userLimit = await checkRateLimitDetailed(
    `rate-limit:findings:delete:user:${userId}`,
    TIERS.ADMIN.limit,
    TIERS.ADMIN.windowSeconds,
    { fallbackStrategy: TIERS.ADMIN.fallbackStrategy, timeoutMs: TIERS.ADMIN.timeoutMs },
  );
  if (!userLimit.allowed) {
    return NextResponse.json(
      { error: "Too Many Requests", message: "Rate limit exceeded." },
      {
        status: 429,
        headers: {
          ...buildRateLimitHeaders(userLimit),
          "Retry-After": String(secondsUntilReset(userLimit.resetAt)),
        },
      },
    );
  }

  const { id } = await params;

  const finding = await prisma.finding.findFirst({
    where: {
      id,
      scanResult: { pullRequest: { repository: { userId } } },
    },
    select: { id: true },
  });
  if (!finding) {
    throw new AppError("Finding not found", 404);
  }

  await prisma.finding.delete({ where: { id } });

  await prisma.auditLog.create({
    data: {
      userId,
      action: "finding.delete",
      resource: `finding:${id}`,
      decision: "ALLOW",
      metadata: { findingId: id },
    },
  });

  return new NextResponse(null, { status: 204 });
});

// ─── Exports ──────────────────────────────────────────────────────────────────

export const GET = withRateLimit(getHandler, {
  ...TIERS.STANDARD,
  keyPrefix: "findings:get",
}) as typeof getHandler;

export const PATCH = withRateLimit(patchHandler, {
  ...TIERS.STANDARD,
  keyPrefix: "findings:patch",
}) as typeof patchHandler;

export const DELETE = withRateLimit(deleteHandler, {
  ...TIERS.ADMIN,
  keyPrefix: "findings:delete",
}) as typeof deleteHandler;
