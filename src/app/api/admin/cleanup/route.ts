import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import { cleanupDataRetention } from "@/lib/retention/cleanup";

/**
 * Validate that the request is authorized via secret token or an active Admin session.
 */
export function isAuthorizedCleanupRequest(
  req: NextRequest,
  sessionUser?: { roles?: string[] } | null,
): boolean {
  // 1. Check Bearer token or secret headers
  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  const secretHeader = req.headers.get("x-cleanup-secret") ?? req.headers.get("x-cron-secret");
  const providedSecret = bearerToken ?? secretHeader;

  const validSecrets = [
    process.env.CLEANUP_SECRET,
    process.env.CRON_SECRET,
    process.env.AUTH_SECRET,
  ].filter((s): s is string => typeof s === "string" && s.trim().length > 0);

  if (providedSecret && validSecrets.length > 0) {
    if (validSecrets.includes(providedSecret)) {
      return true;
    }
  }

  // 2. Check admin user session
  if (sessionUser?.roles?.includes("ADMIN")) {
    return true;
  }

  return false;
}

/**
 * Extract cleanup options from request searchParams or JSON body.
 */
async function extractCleanupOptions(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;

  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try {
      const text = await req.text();
      if (text.trim().length > 0) {
        body = JSON.parse(text);
      }
    } catch {
      throw new AppError("Invalid JSON body", 400);
    }
  }

  const dryRunParam = body.dryRun ?? searchParams.get("dryRun");
  const dryRun =
    typeof dryRunParam === "boolean"
      ? dryRunParam
      : typeof dryRunParam === "string"
        ? dryRunParam.toLowerCase() === "true" || dryRunParam === "1"
        : req.method === "GET"; // GET defaults to dryRun: true

  const daysParam = body.days ?? searchParams.get("days");
  let days: number | undefined;
  if (daysParam !== undefined && daysParam !== null && daysParam !== "") {
    days = Number(daysParam);
    if (!Number.isInteger(days) || days < 1) {
      throw new AppError("Parameter `days` must be a positive integer", 400);
    }
  }

  const batchSizeParam = body.batchSize ?? searchParams.get("batchSize");
  let batchSize: number | undefined;
  if (batchSizeParam !== undefined && batchSizeParam !== null && batchSizeParam !== "") {
    batchSize = Number(batchSizeParam);
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new AppError("Parameter `batchSize` must be a positive integer", 400);
    }
  }

  return { dryRun, days, batchSize };
}

/**
 * POST /api/admin/cleanup
 * Secret-protected endpoint to delete older findings and audit logs in batches.
 * Supports dry-run mode via body or query param `?dryRun=true`.
 */
async function postHandler(req: NextRequest) {
  const session = await auth();
  const sessionUser = session?.user as { roles?: string[] } | undefined;

  if (!isAuthorizedCleanupRequest(req, sessionUser)) {
    throw new AppError("Unauthorized: missing or invalid cleanup secret/admin session", 401);
  }

  const { dryRun, days, batchSize } = await extractCleanupOptions(req);

  const result = await cleanupDataRetention(prisma, {
    dryRun,
    days,
    batchSize,
  });

  return NextResponse.json(result, { status: 200 });
}

/**
 * GET /api/admin/cleanup
 * Secret-protected endpoint to preview retention cleanup counts (dry-run mode).
 */
async function getHandler(req: NextRequest) {
  const session = await auth();
  const sessionUser = session?.user as { roles?: string[] } | undefined;

  if (!isAuthorizedCleanupRequest(req, sessionUser)) {
    throw new AppError("Unauthorized: missing or invalid cleanup secret/admin session", 401);
  }

  const { days, batchSize } = await extractCleanupOptions(req);

  // GET is always dryRun
  const result = await cleanupDataRetention(prisma, {
    dryRun: true,
    days,
    batchSize,
  });

  return NextResponse.json(result, { status: 200 });
}

export const POST = withErrorHandler(postHandler);
export const GET = withErrorHandler(getHandler);
