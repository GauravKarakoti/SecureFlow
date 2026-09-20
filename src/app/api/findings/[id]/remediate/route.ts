import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { generateRemediationPatchFlow } from "@/ai/flows/generate-remediation-patch";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";

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
 * 3. No rate limit — this is the only AI-calling route in the directory with
 *    no `withRateLimit` wrapper. Added using the same TIERS.AI_STREAM tier
 *    the explain-stream route uses.
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
    select: {
      id: true,
      codeSnippet: true,
      description: true,
      fileLocation: true,
    },
  });

  if (!finding) {
    throw new AppError("Finding not found", 404);
  }

  const aiResult = await generateRemediationPatchFlow({
    vulnerableCode: finding.codeSnippet || "",
    findingDescription: finding.description,
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
