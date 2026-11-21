import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import { verifyAuditChain } from "@/lib/audit/verify-chain";
import { parseLimit } from "@/lib/pagination/cursor";

/**
 * Validates admin authentication.
 */
async function requireAdmin() {
  const session = await auth();
  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    throw new AppError("Unauthorized admin access", 401);
  }
  return session;
}

/**
 * GET: Audit Log Hash Chain Verification Endpoint (Admin Only)
 * Walks the cryptographic chain and checks every entry's integrity with optional cursor pagination.
 */
async function getHandler(req: NextRequest) {
  await requireAdmin();

  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor") || undefined;
  const rawLimit = searchParams.get("limit");
  const limit = rawLimit !== null ? parseLimit(rawLimit, 50, 500) : undefined;

  const result = await verifyAuditChain(prisma, { cursor, limit });

  if (!result.valid) {
    return NextResponse.json(
      {
        status: "COMPROMISED",
        ...result,
        firstInvalidEntryId: result.firstInvalidEntryId || result.brokenEntryId,
      },
      { status: 409 },
    );
  }

  return NextResponse.json(
    {
      status: "VALID",
      ...result,
    },
    { status: 200 },
  );
}

export const GET = withRateLimit(
  withErrorHandler(getHandler) as (req: NextRequest) => Promise<NextResponse>,
  { ...TIERS.ADMIN, keyPrefix: "admin:audit:verify" },
);
