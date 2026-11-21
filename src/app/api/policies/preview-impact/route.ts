/**
 * POST /api/policies/preview-impact (#1892)
 *
 * Previews the impact of a draft policy change by replaying the user's
 * recent repository scan inputs against both current and draft policy versions.
 *
 * Guarantees:
 * - 401 for unauthenticated users.
 * - Rate limited per user and IP.
 * - Replays up to N scans (default 20) with token capping.
 * - 100% side-effect free: never writes findings, comments, or check runs.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  withRateLimit,
  TIERS,
  buildRateLimitHeaders,
  secondsUntilReset,
} from "@/lib/middleware/rate-limit";
import { checkRateLimitDetailed } from "@/lib/redis";
import { evaluatePromptSafety } from "@/ai/flows/heist-prompt-guard";
import { previewPolicyImpact } from "@/lib/policies/preview-impact";

export const MAX_POLICY_DESC_LENGTH = 2000;

interface PreviewImpactRequestBody {
  templateId?: string;
  draftDescription?: string;
  draftSeverity?: string;
  maxScans?: number;
  maxTokens?: number;
}

async function handler(req: NextRequest) {
  // 1. Authentication
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. User-scoped rate limit
  const userRateKey = `rate-limit:policy:preview-impact:user:${userId}`;
  const userLimit = await checkRateLimitDetailed(
    userRateKey,
    TIERS.POLICY_TEST.limit,
    TIERS.POLICY_TEST.windowSeconds,
    {
      fallbackStrategy: TIERS.POLICY_TEST.fallbackStrategy,
      timeoutMs: TIERS.POLICY_TEST.timeoutMs,
    },
  );

  if (!userLimit.allowed) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded. Please wait before requesting another policy impact preview.",
      },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          ...buildRateLimitHeaders(userLimit),
          "Retry-After": String(secondsUntilReset(userLimit.resetAt)),
        },
      },
    );
  }

  // 3. Body validation
  let body: PreviewImpactRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { templateId, draftDescription, draftSeverity, maxScans, maxTokens } = body;

  if (typeof templateId !== "string" || !templateId.trim()) {
    return NextResponse.json({ error: "Policy templateId is required" }, { status: 400 });
  }

  if (typeof draftDescription !== "string" || !draftDescription.trim()) {
    return NextResponse.json({ error: "Draft policy description is required" }, { status: 400 });
  }

  if (draftDescription.length > MAX_POLICY_DESC_LENGTH) {
    return NextResponse.json(
      {
        error: `Draft policy description exceeds maximum length of ${MAX_POLICY_DESC_LENGTH} characters`,
      },
      { status: 400 },
    );
  }

  // 4. Prompt safety check
  const safety = await evaluatePromptSafety(draftDescription);
  if (!safety.isSafe) {
    return NextResponse.json(
      {
        error:
          "Draft policy description contains disallowed prompt injection patterns or instructions",
      },
      { status: 400 },
    );
  }

  // 5. Execute preview impact engine
  try {
    const result = await previewPolicyImpact({
      userId,
      templateId: templateId.trim(),
      draftDescription: draftDescription.trim(),
      draftSeverity,
      maxScans,
      maxTokens,
    });

    if (!result.ok && result.error) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (err: unknown) {
    console.error("[PolicyPreviewImpact] Error:", err);
    return NextResponse.json(
      { error: "Failed to generate policy impact preview" },
      { status: 500 },
    );
  }
}

export const POST = withRateLimit(handler, {
  ...TIERS.POLICY_TEST,
  keyPrefix: "policies:preview-impact",
});

export const dynamic = "force-dynamic";
