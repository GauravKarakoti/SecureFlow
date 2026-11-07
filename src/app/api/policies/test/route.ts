/**
 * POST /api/policies/test
 *
 * Runs an isolated policy test with a user-provided code snippet without
 * saving any findings to the database or posting comments to GitHub.
 *
 * Guarantees:
 *  - Authentication required: 401 for unauthenticated users.
 *  - Rate limited per IP & user using TIERS.POLICY_TEST.
 *  - Input bounds: snippet max 64 KB, policy description max 2000 chars.
 *  - Prompt injection pre-filtering: runs evaluatePromptSafety before scanning.
 *  - Zero side effects: findings are returned in the response only.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { withRateLimit, TIERS, buildRateLimitHeaders, secondsUntilReset } from "@/lib/middleware/rate-limit";
import { checkRateLimitDetailed } from "@/lib/redis";
import { evaluatePromptSafety } from "@/ai/flows/heist-prompt-guard";
import { scanner, type FileChange, type ScannerPolicy } from "@/lib/armor/scanner";

export const MAX_SNIPPET_LENGTH = 64 * 1024; // 64 KB
export const MAX_POLICY_DESC_LENGTH = 2000;

interface TestPolicyBody {
  snippet?: string;
  policyDescription?: string;
  filename?: string;
}

async function handler(req: NextRequest) {
  // 1. Authentication check
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. User-scoped rate limit
  const userRateKey = `rate-limit:policy:test:user:${userId}`;
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
      { error: "Rate limit exceeded. Please wait before testing another policy." },
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
  let body: TestPolicyBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { snippet, policyDescription, filename } = body;

  if (typeof snippet !== "string" || !snippet.trim()) {
    return NextResponse.json({ error: "Code snippet is required" }, { status: 400 });
  }

  if (typeof policyDescription !== "string" || !policyDescription.trim()) {
    return NextResponse.json({ error: "Policy description is required" }, { status: 400 });
  }

  if (snippet.length > MAX_SNIPPET_LENGTH) {
    return NextResponse.json(
      { error: `Snippet exceeds maximum length of ${MAX_SNIPPET_LENGTH} characters` },
      { status: 400 },
    );
  }

  if (policyDescription.length > MAX_POLICY_DESC_LENGTH) {
    return NextResponse.json(
      { error: `Policy description exceeds maximum length of ${MAX_POLICY_DESC_LENGTH} characters` },
      { status: 400 },
    );
  }

  // 4. Prompt injection pre-filtering on both policy description and snippet
  const [descSafety, snippetSafety] = await Promise.all([
    evaluatePromptSafety(policyDescription),
    evaluatePromptSafety(snippet),
  ]);

  if (!descSafety.isSafe) {
    return NextResponse.json(
      { error: "Policy description contains disallowed prompt injection patterns or instructions" },
      { status: 400 },
    );
  }

  if (!snippetSafety.isSafe) {
    return NextResponse.json(
      { error: "Code snippet contains disallowed prompt injection instructions" },
      { status: 400 },
    );
  }

  // 5. Construct synthesized diff for the scanner
  const targetFile = (filename && filename.trim()) || "snippet.ts";
  const patchLines = snippet
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
  const simulatedPatch = `@@ -0,0 +1,${snippet.split("\n").length} @@\n${patchLines}`;

  const files: FileChange[] = [
    {
      filename: targetFile,
      patch: simulatedPatch,
    },
  ];

  const activePolicy: ScannerPolicy = {
    description: policyDescription.trim(),
  };

  // 6. Run the scanner in-memory with ONLY this policy
  try {
    const rawFindings = await scanner.scanPullRequest(files, [activePolicy], [], []);

    const findings = rawFindings.map((f: any) => ({
      type: f.type,
      severity: f.severity,
      description: f.description,
      explanation: f.explanation || f.description,
      fileLocation: f.fileLocation,
      lineStart: f.lineStart,
      lineEnd: f.lineEnd,
    }));

    return NextResponse.json({
      success: true,
      findingsCount: findings.length,
      findings,
    });
  } catch (err) {
    console.error("[PolicyTest] Scan failed:", err);
    return NextResponse.json(
      { error: "Policy test scan failed. Please check the policy phrasing and try again." },
      { status: 500 },
    );
  }
}

export const POST = withRateLimit(handler, {
  ...TIERS.POLICY_TEST,
  keyPrefix: "policies:test",
});

export const dynamic = "force-dynamic";
