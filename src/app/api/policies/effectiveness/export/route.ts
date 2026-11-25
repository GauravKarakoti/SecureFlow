import { NextRequest, NextResponse } from "next/server";
import { authenticateUserOrToken } from "@/lib/auth/api-token";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import {
  fetchPolicyEffectivenessData,
  exportPolicyMetricsToCSV,
} from "@/lib/policies/effectiveness";

/**
 * GET: Export policy effectiveness report as CSV with formula-injection protection (#2019).
 * Query params:
 *   - days: evaluation period in days (defaults to 30)
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
  const csv = exportPolicyMetricsToCSV(summary);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="policy-effectiveness-report-${days}d.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

export const GET = withRateLimit(
  withErrorHandler(getHandler) as (req: NextRequest) => Promise<NextResponse>,
  { ...TIERS.STANDARD, keyPrefix: "policies:effectiveness:export" },
);
