/**
 * POST /api/cli/scan — AI-powered scan for the SecureFlow CLI.
 *
 * Calls the same ArmorIQScanner the GitHub App webhook uses
 * (src/lib/armor/scanner.ts), so the CLI's AI scan and the App's PR scan
 * share one implementation. The CLI sends full staged-file content, not
 * a diff, so each file is wrapped in a synthetic "every line added"
 * unified patch before being handed to the scanner — matching the exact
 * format `parseUnifiedPatch` (src/lib/armor/diff.ts) expects.
 *
 * Auth: none beyond the existing IP-based rate limiting. A single
 * shared secret can't do per-user attribution or revocation since it
 * has to be handed to every legitimate CLI user anyway (see PR
 * discussion); real per-user API keys are tracked as a follow-up.
 */
import { getOrSynthesize } from "@/lib/audio-cache";
import { resolveVoiceId, streamSpeech } from "@/lib/elevenlabs";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import {
  withRateLimit,
  TIERS,
  buildRateLimitHeaders,
  secondsUntilReset,
} from "@/lib/middleware/rate-limit";
import { checkRateLimitDetailed } from "@/lib/redis";
import { scanner, type FileChange } from "@/lib/armor/scanner";
import { readBoundedRequestBody } from "@/lib/request-body";
import {
  MAX_FILES_PER_REQUEST,
  MAX_FILE_CONTENT_LENGTH,
  MAX_PATH_LENGTH,
  MAX_SCAN_REQUEST_BYTES,
  cliScanRequestSchema,
  cliScanResponseSchema,
} from "secureflow-cli/contracts";

export {
  MAX_FILES_PER_REQUEST,
  MAX_FILE_CONTENT_LENGTH,
  MAX_PATH_LENGTH,
  MAX_SCAN_REQUEST_BYTES,
  cliScanRequestSchema,
  cliScanResponseSchema,
};

/**
 * Wraps full file content as a unified diff whose every line is "added",
 * in the exact shape `parseUnifiedPatch` (src/lib/armor/diff.ts) parses:
 * a single `@@ -0,0 +1,N @@` hunk followed by N `+`-prefixed lines. The
 * CLI has no prior commit to diff a staged, uncommitted file against —
 * scanning "everything currently staged" is the same scope as a
 * from-scratch PR that adds the file.
 */
function toSyntheticAddedPatch(content: string): string {
  if (typeof content !== "string" || content.length === 0) {
    return "";
  }
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (normalized.length === 0) {
    return "";
  }
  const lines = normalized.split("\n");
  const header = `@@ -0,0 +1,${lines.length} @@`;
  const body = lines.map((line) => `+${line}`).join("\n");
  return `${header}\n${body}\n`;
}

async function streamToBuffer(stream: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(stream)) return stream;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const handler = withErrorHandler(async function POST(req: NextRequest) {
  // 1. Authenticated User Rate Limit Check
  const session = await auth();
  const userId = session?.user?.id;
  if (userId) {
    const userLimit = await checkRateLimitDetailed(
      `rate-limit:cli:scan:user:${userId}`,
      TIERS.SCAN_USER.limit,
      TIERS.SCAN_USER.windowSeconds,
      {
        fallbackStrategy: TIERS.SCAN_USER.fallbackStrategy,
        timeoutMs: TIERS.SCAN_USER.timeoutMs,
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
            "Cache-Control": "no-store",
            ...buildRateLimitHeaders(userLimit),
            "Retry-After": String(secondsUntilReset(userLimit.resetAt)),
          },
        },
      );
    }
  }

  // 2. Early Content-Length check: reject oversized requests before reading body stream
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(contentLength) && contentLength > MAX_SCAN_REQUEST_BYTES) {
      throw new AppError("Request payload exceeds maximum allowed size", 413);
    }
  }

  // 3. Read bounded request body text (streaming abort if > MAX_SCAN_REQUEST_BYTES)
  const rawText = await readBoundedRequestBody(req, MAX_SCAN_REQUEST_BYTES);

  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    throw new AppError("Request body is not valid JSON", 400);
  }

  const parsed = cliScanRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(parsed.error.issues[0]?.message ?? "Invalid scan request", 400);
  }
  const { files } = parsed.data;

  const fileChanges: FileChange[] = files.map((f) => ({
    filename: f.path,
    patch: toSyntheticAddedPatch(f.content),
  }));

  // No custom policies from the CLI today, so the scanner narrows itself
  // to its default secret-detection rules (see scanner.ts's
  // policyInstructions branch) -- the same scope as the CLI's own local
  // scanFile() check, just AI-powered on top of it.
  const findings = fileChanges.length > 0 ? await scanner.scanPullRequest(fileChanges) : [];

  let audioBase64: string | undefined;
  if (parsed.data.voice && process.env.ELEVENLABS_API_KEY) {
    try {
      const summary =
        parsed.data.summaryText ||
        (findings.length > 0
          ? `SecureFlow scan completed with ${findings.length} findings.`
          : "SecureFlow scan passed cleanly.");
      const voiceId = resolveVoiceId("default");
      const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
      const audio = await getOrSynthesize(summary, voiceId, modelId, async () =>
        streamToBuffer(await streamSpeech(summary, { voiceId, modelId })),
      );
      audioBase64 = audio.toString("base64");
    } catch {
      // Graceful fallback
    }
  }

  return NextResponse.json(
    { findings, ...(audioBase64 ? { audioBase64 } : {}) },
    { headers: { "Cache-Control": "no-store" } },
  );
});

export const POST = withRateLimit(handler, {
  limit: 20,
  windowSeconds: 60,
  keyPrefix: "cli:scan",
  fallbackStrategy: "fail-closed",
});

export const dynamic = "force-dynamic";
