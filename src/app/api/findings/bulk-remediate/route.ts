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
import { withErrorHandler } from "@/lib/middleware/error-handler";
import { ArmorIQService } from "@/lib/armor/iq";
import { ArmorIQUnavailableError, withArmorIQBreaker } from "@/lib/armor/armoriq-breaker";

const MAX_BULK_REMEDIATION_FINDINGS = MAX_PAGE_SIZE;

/** Actions the bulk remediation endpoint understands. */
const BULK_REMEDIATION_ACTIONS = new Set(["generate", "apply", "rollback"]);

/** Maximum allowed payload size for bulk remediation requests (128 KB). */
export const MAX_BULK_REQUEST_BYTES = 128 * 1024;

type BoundedBody = { text: string } | { tooLarge: true } | { unreadable: true };

/**
 * Read a request body without buffering more than `limit` bytes.
 *
 * `Content-Length` is advisory: chunked requests omit it, and a client can send
 * a smaller value than the bytes that follow. The stream is therefore the
 * authority. The reader is cancelled as soon as the running byte count crosses
 * the cap, so an oversized upload is not accumulated in memory first.
 */
async function readBoundedBody(req: NextRequest, limit: number): Promise<BoundedBody> {
  if (!req.body) return { text: "" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { unreadable: true };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { text: new TextDecoder().decode(merged) };
}

interface BulkFindingRecord {
  id: string;
  type: string;
  fileLocation: string;
  codeSnippet?: string | null;
  explanation?: string | null;
  remediation?: string | null;
}

interface RemediationPatchDelegate {
  remediationPatch: {
    updateMany: (args: {
      where: { findingId: { in: string[] } };
      data: { status: string };
    }) => Promise<{ count: number }>;
    upsert: (args: {
      where: { findingId: string };
      update: { patchDiff: string; status: string };
      create: { findingId: string; patchDiff: string; status: string };
    }) => Promise<unknown>;
  };
}

/* POST /api/findings/bulk-remediate */
const handler = async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    // Early Content-Length check to reject oversized payloads before buffering
    const contentLengthHeader = req.headers.get("content-length");
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (!Number.isNaN(contentLength) && contentLength > MAX_BULK_REQUEST_BYTES) {
        return NextResponse.json(
          { error: "Request payload exceeds maximum allowed size" },
          { status: 413 },
        );
      }
    }

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

    const bodyResult = await readBoundedBody(req, MAX_BULK_REQUEST_BYTES);
    if ("tooLarge" in bodyResult) {
      return NextResponse.json(
        { error: "Request payload exceeds maximum allowed size" },
        { status: 413 },
      );
    }
    if ("unreadable" in bodyResult) {
      return NextResponse.json({ error: "Cannot read request body" }, { status: 400 });
    }
    const rawText = bodyResult.text;

    let body: { action?: string; findingIds?: unknown };
    try {
      body = JSON.parse(rawText);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { action, findingIds } = body;

    if (
      action !== undefined &&
      (typeof action !== "string" || !BULK_REMEDIATION_ACTIONS.has(action))
    ) {
      return NextResponse.json(
        { error: "action must be one of generate, apply, or rollback" },
        { status: 400 },
      );
    }

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

    const uniqueIds = Array.from(new Set(findingIds as string[]));

    if (uniqueIds.length > MAX_BULK_REMEDIATION_FINDINGS) {
      return NextResponse.json(
        { error: `findingIds may contain at most ${MAX_BULK_REMEDIATION_FINDINGS} findings` },
        { status: 400 },
      );
    }

    // Load findings owned by the authenticated user to verify authorization
    const findings = (await prisma.finding.findMany({
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
    })) as unknown as BulkFindingRecord[];

    if (findings.length === 0) {
      return NextResponse.json({ error: "No matching findings found" }, { status: 404 });
    }

    if (findings.length !== uniqueIds.length) {
      return NextResponse.json(
        { error: "One or more findings could not be found or access is denied" },
        { status: 403 },
      );
    }

    // Authorize bulk actions through ArmorIQ when applying remediation patches
    if (action === "apply") {
      const armorClient = ArmorIQService.getClient();
      if (armorClient) {
        try {
          const bulkPlan = {
            goal: "Bulk apply remediation patches across verified repository findings",
            steps: findings.map((f) => ({
              action: "fs.readwrite",
              mcp: "secureflow",
              params: {
                findingId: f.id,
                path: f.fileLocation,
                type: f.type,
              },
            })),
          };

          const policy = {
            allow: ["fs.readwrite"],
            deny: ["github.push"],
            hold: [],
            priority: 100,
          };

          const capture = armorClient.capturePlan(
            "secureflow",
            `Apply bulk remediation patches for ${findings.length} findings.`,
            bulkPlan,
            { findingIds: uniqueIds },
          );

          const token = await withArmorIQBreaker(() =>
            armorClient.getIntentToken(capture, policy, 300),
          );
          const verification = await ArmorIQService.verifyIntentToken(token);

          if (verification.unavailable) {
            return NextResponse.json(
              { error: "ArmorIQ is temporarily unavailable; remediation is blocked" },
              { status: 503 },
            );
          }

          if (!verification.valid) {
            return NextResponse.json(
              { error: "ArmorIQ intent verification failed; remediation is blocked" },
              { status: 403 },
            );
          }
        } catch (error) {
          console.error("[BULK_REMEDIATE] ArmorIQ authorization failed:", error);
          if (error instanceof ArmorIQUnavailableError) {
            return NextResponse.json(
              { error: "ArmorIQ is temporarily unavailable; remediation is blocked" },
              { status: 503 },
            );
          }
          return NextResponse.json(
            { error: "ArmorIQ authorization failed; remediation is blocked" },
            { status: 403 },
          );
        }
      }
    }

    // Process Apply or Rollback actions
    if (action === "apply" || action === "rollback") {
      const newStatus = action === "rollback" ? "PENDING" : "APPLIED";
      let updatedCount = 0;

      if (typeof prisma.$transaction === "function") {
        await prisma.$transaction(async (tx: unknown) => {
          const client = tx as RemediationPatchDelegate;
          const result = await client.remediationPatch.updateMany({
            where: { findingId: { in: uniqueIds } },
            data: { status: newStatus },
          });
          updatedCount = result.count;
        });
      } else {
        const result = await (
          prisma as unknown as RemediationPatchDelegate
        ).remediationPatch.updateMany({
          where: { findingId: { in: uniqueIds } },
          data: { status: newStatus },
        });
        updatedCount = result.count;
      }

      return NextResponse.json({
        success: true,
        updatedCount,
        status: newStatus,
      });
    }

    // Process Generate action (Default AI Flow)
    const types = Array.from(new Set(findings.map((f) => f.type)));
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
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : "AI patch generation failed";
        failedItems.push({
          findingId: finding.id,
          error: errorMessage,
        });
        break;
      }
    }

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

    // 2. Execute database mutations atomically inside prisma.$transaction
    const savePatches = async (txClient: unknown) => {
      const client = txClient as RemediationPatchDelegate;
      const patches: unknown[] = [];
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
  withErrorHandler(handler as (req: NextRequest, ...args: unknown[]) => Promise<NextResponse>, {
    routeLabel: "findings:bulk-remediate",
  }) as (req: NextRequest, ...args: unknown[]) => Promise<NextResponse>,
  { ...TIERS.AI_STREAM, keyPrefix: "bulk-remediate:ip" },
) as typeof handler;
