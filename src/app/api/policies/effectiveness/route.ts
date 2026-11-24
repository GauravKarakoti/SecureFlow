import { NextRequest, NextResponse } from "next/server";
import { authenticateUserOrToken } from "@/lib/auth/api-token";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import { fetchPolicyEffectivenessData } from "@/lib/policies/effectiveness";

/**
 * GET: Retrieve policy effectiveness metrics for the signed-in user/token.
 * Query params:
 *   - days: number of days in evaluation window (7, 30, 90; defaults to 30)
 */
async function getHandler(req: NextRequest) {
  const authRes = await authenticateUserOrToken(req, { requiredScopes: ["policies:read"] });
  if (!authRes.ok) {
    throw new AppError(authRes.message, authRes.status);
  }

  const { searchParams } = new URL(req.url);
  const rawDays = searchParams.get("days");
  let days = 30;
  if (rawDays) {
    const parsed = parseInt(rawDays, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 365) {
      days = parsed;
    }
  }

  const summary = await fetchPolicyEffectivenessData(authRes.userId, days);

  return NextResponse.json(summary);
}

export const GET = withRateLimit(
  withErrorHandler(getHandler) as (req: NextRequest) => Promise<NextResponse>,
  { ...TIERS.STANDARD, keyPrefix: "policies:effectiveness" },
);
