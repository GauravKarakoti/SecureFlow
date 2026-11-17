import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { generateAllWeeklyDigests } from "@/lib/digest/digest-service";

export const dynamic = "force-dynamic";

/**
 * Constant-time string comparison to prevent timing attacks on CRON_SECRET.
 */
function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify caller has provided the expected CRON_SECRET.
 */
function isCronAuthorized(req: NextRequest): boolean {
  const configuredSecret = process.env.CRON_SECRET?.trim();

  // In production, CRON_SECRET must be configured
  if (!configuredSecret) {
    if (process.env.NODE_ENV === "production") {
      return false;
    }
    // In local development/test without CRON_SECRET, permit invocation
    return true;
  }

  // Check Bearer authorization header
  const authHeader = req.headers.get("authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (secureCompare(token, configuredSecret)) {
      return true;
    }
  }

  // Check x-cron-secret header
  const customHeader = req.headers.get("x-cron-secret")?.trim();
  if (customHeader && secureCompare(customHeader, configuredSecret)) {
    return true;
  }

  return false;
}

async function handleWeeklyDigestCron(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      {
        error: "UNAUTHORIZED",
        message: "Missing or invalid authorization for cron trigger.",
      },
      { status: 401 },
    );
  }

  try {
    const force = req.nextUrl.searchParams.get("force") === "true";
    const result = await generateAllWeeklyDigests({ force });

    return NextResponse.json({
      success: true,
      totalUsers: result.totalUsers,
      generated: result.generated,
      skipped: result.skipped,
      errorsCount: result.errors.length,
      errors: result.errors,
    });
  } catch (err: unknown) {
    console.error("[WeeklyDigestCron] Failed to execute cron job:", err);
    return NextResponse.json(
      {
        error: "INTERNAL_SERVER_ERROR",
        message: err instanceof Error ? err.message : "Unknown server error",
      },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return handleWeeklyDigestCron(req);
}

export async function POST(req: NextRequest) {
  return handleWeeklyDigestCron(req);
}
