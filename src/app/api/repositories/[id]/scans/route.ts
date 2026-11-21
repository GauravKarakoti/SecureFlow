import { NextRequest, NextResponse } from "next/server";
import { authenticateUserOrToken } from "@/lib/auth/api-token";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import { getRepositoryScanSeverityTrend } from "@/lib/repositories/scan-trend";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function handleGetScanTrend(
  req: NextRequest,
  context?: { params?: Promise<{ id?: string }> | { id?: string } },
) {
  const authRes = await authenticateUserOrToken(req, { requiredScopes: ["scans:read"] });
  if (!authRes.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const resolvedParams = context?.params ? await Promise.resolve(context.params) : undefined;
  const url = new URL(req.url);
  const repositoryId =
    resolvedParams?.id || url.searchParams.get("repositoryId") || url.searchParams.get("id");

  if (!repositoryId) {
    return NextResponse.json(
      { error: "Repository ID is required" },
      { status: 400, headers: NO_STORE },
    );
  }

  const daysParam = url.searchParams.get("days") || url.searchParams.get("range") || "30";
  const days = parseInt(daysParam, 10);

  const result = await getRepositoryScanSeverityTrend(
    repositoryId,
    authRes.userId,
    isNaN(days) ? 30 : days,
  );

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  }

  return NextResponse.json(result.data, {
    status: 200,
    headers: NO_STORE,
  });
}

const getHandler = withErrorHandler(handleGetScanTrend, {
  routeLabel: "GET /api/repositories/[id]/scans",
});

export const GET = withRateLimit(getHandler, {
  ...TIERS.STANDARD,
  keyPrefix: "repo-scans-trend",
});
