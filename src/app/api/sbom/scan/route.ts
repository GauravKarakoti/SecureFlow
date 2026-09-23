/**
 * POST /api/sbom/scan — Enqueue an asynchronous SBOM scan.
 *
 * Accepts manifest file contents (e.g. package.json or requirements.txt)
 * and enqueues a background job to BullMQ rather than performing CPU-heavy
 * dependency parsing and vulnerability matching inside the HTTP request.
 *
 * Returns immediately with HTTP 202 Accepted and a job handle that can
 * be polled at /api/sbom/scan/status/[jobId].
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import { withRateLimit } from "@/lib/middleware/rate-limit";
import { enqueueSbomScan, MAX_SBOM_BYTES } from "@/lib/queue/sbomQueue";
import { isSupportedManifest, SUPPORTED_MANIFESTS } from "@/lib/sbom/dependency-parser";
import prisma from "@/lib/prisma";
import { z } from "zod";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Maximum allowed HTTP request body size (1 MB manifest + 64 KB JSON envelope). */
export const MAX_REQUEST_BYTES = MAX_SBOM_BYTES + 64 * 1024;

const sbomScanSchema = z.object({
  fileName: z
    .string()
    .min(1, "fileName is required")
    .refine((name) => !name.includes("..") && !name.startsWith("/"), {
      message: "fileName must not contain path traversal characters",
    })
    // An unsupported file parses to zero dependencies, which the worker would report as CLEAN.
    .refine(isSupportedManifest, {
      message: `fileName must be a supported manifest (${SUPPORTED_MANIFESTS.join(", ")})`,
    }),
  content: z.string().min(1, "content is required"),
  repositoryId: z.string().optional(),
});

/**
 * Safely read bounded request body text up to maxBytes without buffering excessive memory.
 */
async function readBoundedRequestBody(req: NextRequest, maxBytes: number): Promise<string> {
  // If streaming body reader is available, read chunk by chunk with early abort
  if (req.body && typeof req.body.getReader === "function") {
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new AppError("Request payload exceeds maximum allowed size", 413);
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock?.();
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8").decode(combined);
  }

  // Fallback for runtimes or mocks exposing req.text()
  if (typeof req.text === "function") {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf-8") > maxBytes) {
      throw new AppError("Request payload exceeds maximum allowed size", 413);
    }
    return text;
  }

  throw new AppError("Cannot read request body", 400);
}

const handler = withErrorHandler(async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new AppError("Unauthorized", 401);
  }
  const userId = session.user.id;

  // 1. Early Content-Length check: reject oversized requests before reading body
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(contentLength) && contentLength > MAX_REQUEST_BYTES) {
      throw new AppError("Request payload exceeds maximum allowed size", 413);
    }
  }

  // 2. Read bounded request body text
  const rawText = await readBoundedRequestBody(req, MAX_REQUEST_BYTES);

  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    throw new AppError("Request body must be valid JSON", 400);
  }

  const parsed = sbomScanSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(parsed.error.issues.map((i) => i.message).join(", "), 400);
  }

  const { fileName, content, repositoryId } = parsed.data;

  // 3. Validate manifest content byte length strictly
  const byteLength = Buffer.byteLength(content, "utf-8");
  if (byteLength > MAX_SBOM_BYTES) {
    throw new AppError(
      `Manifest file exceeds maximum allowed size of ${MAX_SBOM_BYTES} bytes (1MB)`,
      413,
    );
  }

  // 4. Verify repository ownership if caller-supplied repositoryId is provided
  let verifiedRepositoryId: string | undefined;
  if (repositoryId) {
    const repo = await prisma.repository.findFirst({
      where: {
        id: repositoryId,
        userId,
      },
      select: { id: true },
    });

    if (!repo) {
      throw new AppError("Repository not found", 404);
    }
    verifiedRepositoryId = repo.id;
  }

  const { jobId, scanJobId } = await enqueueSbomScan({
    fileName,
    content,
    userId,
    repositoryId: verifiedRepositoryId,
  });

  return NextResponse.json(
    {
      status: "queued",
      jobId,
      scanJobId,
      message: "SBOM scan job enqueued successfully",
      pollingUrl: `/api/sbom/scan/status/${scanJobId}`,
    },
    { status: 202, headers: NO_STORE },
  );
});

export const POST = withRateLimit(handler, {
  limit: 30,
  windowSeconds: 60,
  keyPrefix: "sbom:scan",
});

export const dynamic = "force-dynamic";
