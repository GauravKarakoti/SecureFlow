import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { generateRemediationPatchFlow } from "@/ai/flows/generate-remediation-patch";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import {
  withRateLimit,
  TIERS,
  buildRateLimitHeaders,
  secondsUntilReset,
} from "@/lib/middleware/rate-limit";
import { checkRateLimitDetailed } from "@/lib/redis";

/**
 * POST /api/findings/[id]/remediate
 *
 * Generates an AI remediation patch for a specific finding.
 *
 * Security fixes applied:
 *
 * 1. IDOR/BOLA — ownership check (#bug)
 *    The previous handler fetched the finding with `findUnique({ where: { id } })`
 *    and checked only that it existed. Any authenticated user who knew a finding
 *    ID could trigger AI patch generation and write to `remediationPatch` for
 *    someone else's finding. The fix scopes the lookup to the session user via
 *    the relation chain: finding → scanResult → pullRequest → repository → userId.
 *    A finding the caller does not own is indistinguishable from one that does
 *    not exist (404), matching the pattern used by the status and explain-stream
 *    routes.
 *
 * 2. Wrong field name — `finding.filePath` does not exist on the Prisma model.
 *    The schema has `fileLocation`. At runtime this was always `undefined`,
 *    so the AI received an empty file path on every call.
 *
 * 3. Rate limiting — dual-tier rate limiting: IP-based outer guard (`withRateLimit`)
 *    and strict per-user inner guard (`checkRateLimitDetailed`) to prevent LLM denial-of-wallet.
 */
const handler = withErrorHandler(async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new AppError("Unauthorized", 401);
  }
  const userId = session.user.id;

  // Strict user-based token bucket: inner guard keyed per authenticated user
  const userLimit = await checkRateLimitDetailed(
    `rate-limit:findings:remediate:user:${userId}`,
    TIERS.AI_STREAM_USER.limit,
    TIERS.AI_STREAM_USER.windowSeconds,
    {
      fallbackStrategy: TIERS.AI_STREAM_USER.fallbackStrategy,
      timeoutMs: TIERS.AI_STREAM_USER.timeoutMs,
    },
  );
  if (!userLimit.allowed) {
    return NextResponse.json(
      {
        error: "Too Many Requests",
        message: "You have exceeded the rate limit. Please try again later.",
      },
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

  // Ownership check: scope the lookup to the session user via the relation
  // chain. A finding the caller does not own returns the same 404 as one that
  // does not exist — distinguishing the two would make this endpoint an oracle
  // for "does this finding id exist", which is most of what IDOR wants.
  const finding = await prisma.finding.findFirst({
    where: {
      id,
      scanResult: {
        pullRequest: {
          repository: { userId },
        },
      },
    },
    // Only columns `Finding` has. This selected `description`, which is a field
    // of the scanner's in-memory finding but not of the table, and Prisma rejects
    // an unknown select key at runtime ("Unknown field `description` for select
    // statement on model `Finding`") before the query is even sent — so every
    // request failed with a 500 and no patch was ever generated. The typed
    // client does not catch it, which is how it survived.
    select: {
      id: true,
      type: true,
      codeSnippet: true,
      explanation: true,
      remediation: true,
      fileLocation: true,
    },
  });

  if (!finding) {
    throw new AppError("Finding not found", 404);
  }

  const aiResult = await generateRemediationPatchFlow({
    vulnerableCode: finding.codeSnippet || "",
    // The same fallback chain as /api/findings/bulk-remediate.
    findingDescription:
      finding.explanation || finding.remediation || `${finding.type} vulnerability`,
    // Fixed: was `finding.filePath` which does not exist on the Prisma model.
    // The correct field is `fileLocation`.
    filePath: finding.fileLocation,
  });

  const patch = await prisma.remediationPatch.upsert({
    where: { findingId: id },
    update: { patchDiff: aiResult.patchDiff, status: "GENERATED" },
    create: { findingId: id, patchDiff: aiResult.patchDiff, status: "GENERATED" },
  });

  return NextResponse.json({ success: true, patch, explanation: aiResult.explanation });
});

export const POST = withRateLimit(
  handler as (req: NextRequest, ...args: unknown[]) => Promise<NextResponse>,
  { ...TIERS.AI_STREAM, keyPrefix: "findings:remediate" },
);

export const dynamic = "force-dynamic";
