import {
  withRateLimit,
  TIERS,
  buildRateLimitHeaders,
  secondsUntilReset,
} from "@/lib/middleware/rate-limit";
import { checkRateLimitDetailed } from "@/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { generateRemediationPatchFlow } from "@/ai/flows/generate-remediation-patch";
import { MAX_PAGE_SIZE } from "@/lib/findings/query";

/**
 * Most findings one request may remediate.
 *
 * Every finding is a separate AI call, all started at once, while the rate limit
 * counts the request once. The dashboard can only select findings on the current
 * page, so a page is the ceiling a real caller reaches.
 */
const MAX_BULK_REMEDIATION_FINDINGS = MAX_PAGE_SIZE;

/* POST /api/findings/bulk-remediate */
const handler = async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    // Strict user-based token bucket: inner guard keyed per authenticated user
    const userLimit = await checkRateLimitDetailed(
      `rate-limit:bulk-remediate:user:${userId}`,
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

    let body: { action?: string; findingIds?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { action, findingIds } = body;

    if (
      !Array.isArray(findingIds) ||
      findingIds.length === 0 ||
      !findingIds.every((id) => typeof id === "string")
    ) {
      return NextResponse.json(
        { error: "findingIds must be a non-empty array of strings" },
        { status: 400 },
      );
    }

    // A repeated id is one finding. `findMany` returns each row once, so
    // comparing its length against the raw array answered 403 "access is
    // denied" for a request that only named the same finding twice.
    const uniqueIds = Array.from(new Set(findingIds as string[]));

    if (uniqueIds.length > MAX_BULK_REMEDIATION_FINDINGS) {
      return NextResponse.json(
        { error: `findingIds may contain at most ${MAX_BULK_REMEDIATION_FINDINGS} findings` },
        { status: 400 },
      );
    }

    // Load findings owned by the authenticated user to verify authorization
    const findings: any[] = await prisma.finding.findMany({
      where: {
        id: { in: uniqueIds },
        scanResult: { pullRequest: { repository: { userId } } },
      },
      include: {
        scanResult: {
          include: {
            pullRequest: {
              include: { repository: true },
            },
          },
        },
      },
    });

    if (findings.length === 0) {
      return NextResponse.json({ error: "No matching findings found" }, { status: 404 });
    }

    if (findings.length !== uniqueIds.length) {
      return NextResponse.json(
        { error: "One or more findings could not be found or access is denied" },
        { status: 403 },
      );
    }

    // Process Apply or Rollback actions
    if (action === "apply" || action === "rollback") {
      const newStatus = action === "rollback" ? "PENDING" : "APPLIED";

      if (typeof prisma.$transaction === "function") {
        await prisma.$transaction(async (tx: any) => {
          await tx.remediationPatch.updateMany({
            where: { findingId: { in: uniqueIds } },
            data: { status: newStatus },
          });
        });
      } else {
        await prisma.remediationPatch.updateMany({
          where: { findingId: { in: uniqueIds } },
          data: { status: newStatus },
        });
      }

      return NextResponse.json({
        success: true,
        updatedCount: uniqueIds.length,
        status: newStatus,
      });
    }

    // Process Generate action (Default AI Flow)
    // Enforce type homogeneity: bulk remediation requires findings of the same vulnerability type
    const types = Array.from(new Set(findings.map((f: any) => f.type)));
    if (types.length > 1) {
      return NextResponse.json(
        {
          error:
            "Bulk remediation requires all selected findings to be of the same vulnerability type",
          details: { types },
        },
        { status: 400 },
      );
    }

    // 1. Process all external AI patch generations PRIOR to entering the database transaction
    const generatedResults: Array<{
      findingId: string;
      fileLocation: string;
      patchDiff: string;
      explanation: string;
    }> = [];

    const failedItems: Array<{ findingId: string; error: string }> = [];

    for (const finding of findings) {
      try {
        const aiResult = await generateRemediationPatchFlow({
          vulnerableCode: finding.codeSnippet || "",
          findingDescription:
            finding.explanation || finding.remediation || `${finding.type} vulnerability`,
          filePath: finding.fileLocation,
        });

        if (!aiResult || !aiResult.patchDiff) {
          throw new Error("AI patch generation returned empty diff");
        }

        generatedResults.push({
          findingId: finding.id,
          fileLocation: finding.fileLocation,
          patchDiff: aiResult.patchDiff,
          explanation: aiResult.explanation,
        });
      } catch (err: any) {
        failedItems.push({
          findingId: finding.id,
          error: err?.message || "AI patch generation failed",
        });
        // Abort on failure to guarantee strict atomicity and safe rollback
        break;
      }
    }

    // If any item failed generation, abort the entire transaction safely without writing to DB
    if (failedItems.length > 0) {
      return NextResponse.json(
        {
          error: "Bulk remediation aborted: AI patch generation failed for one or more findings",
          failedItems,
          successCount: 0,
          totalCount: findings.length,
        },
        { status: 400 },
      );
    }

    // 2. All external data collected successfully. Execute database mutations atomically inside prisma.$transaction.
    const savePatches = async (client: any) => {
      const patches: any[] = [];
      for (const item of generatedResults) {
        const patch = await client.remediationPatch.upsert({
          where: { findingId: item.findingId },
          update: { patchDiff: item.patchDiff, status: "GENERATED" },
          create: { findingId: item.findingId, patchDiff: item.patchDiff, status: "GENERATED" },
        });
        patches.push(patch);
      }
      return patches;
    };

    await (typeof prisma.$transaction === "function"
      ? prisma.$transaction(savePatches)
      : savePatches(prisma));

    // Combine individual diffs into a unified multi-file diff
    const combinedDiff = generatedResults.map((r) => r.patchDiff).join("\n\n");
    const combinedExplanation =
      `Bulk remediation patch for ${findings.length} ${types[0]} findings across repository:\n` +
      generatedResults.map((r) => `• ${r.fileLocation}: ${r.explanation}`).join("\n");

    return NextResponse.json({
      success: true,
      patch: {
        patchDiff: combinedDiff,
        status: "GENERATED",
      },
      explanation: combinedExplanation,
      count: findings.length,
      type: types[0],
    });
  } catch (error) {
    console.error("[BULK_REMEDIATE_ERROR]", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
};

export const POST = withRateLimit(
  handler as (req: NextRequest, ...args: unknown[]) => Promise<NextResponse>,
  { ...TIERS.AI_STREAM, keyPrefix: "bulk-remediate:ip" },
) as typeof handler;
