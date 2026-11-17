import { NextRequest, NextResponse } from "next/server";
import { generateBadgeSvg, type BadgeState } from "@/lib/badge";
import { withErrorHandler } from "@/lib/middleware/error-handler";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Map a Prisma `PRStatus` (or the absence of any scan) to a badge state.
 *
 * The mapping uses the latest pull request's status as the canonical signal:
 *   PASS            → "passing"
 *   REVIEW_REQUIRED → "review required"
 *   BLOCKED         → "blocked"
 *   (no PR / scan)  → "unknown"
 */
function statusToBadge(prStatus: string | null | undefined): BadgeState {
  switch (prStatus) {
    case "PASS":
      return "passing";
    case "REVIEW_REQUIRED":
      return "review required";
    case "BLOCKED":
      return "blocked";
    default:
      return "unknown";
  }
}

interface RouteParams {
  params: Promise<{ owner: string; repo: string }>;
}

async function handler(_req: NextRequest, context: RouteParams): Promise<NextResponse> {
  const { owner, repo } = await context.params;
  const fullName = `${owner}/${repo}`;
  let state: BadgeState = "unknown";
  let unavailable = false;

  try {
    // Load Prisma inside the handler so a database initialization failure cannot
    // prevent this public image route from returning an SVG at all.
    const { default: prisma } = await import("@/lib/prisma");
    const repository = await prisma.repository.findFirst({
      where: { fullName, isActive: true },
      select: {
        publicBadgeEnabled: true,
        pullRequests: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { status: true },
        },
      },
    });

    if (repository?.publicBadgeEnabled) {
      state = statusToBadge(repository.pullRequests[0]?.status);
    }
  } catch (error) {
    unavailable = true;
    logger.warn("Public badge status unavailable; serving neutral badge", {
      repository: fullName,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }

  // Even when the repo exists but badges are disabled, we return "unknown" —
  // never leaking the actual scan status.
  const svg = generateBadgeSvg(state);

  return new NextResponse(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": unavailable ? "no-store" : "public, max-age=300, s-maxage=300",
    },
  });
}

/**
 * GET /api/badge/[owner]/[repo]
 *
 * Returns a shields.io-style SVG badge reflecting the latest scan status.
 * Rate-limited with the STANDARD tier to keep database load low.
 */
export const GET = withErrorHandler(
  withRateLimit(handler, { ...TIERS.STANDARD, keyPrefix: "badge" }),
  { routeLabel: "GET /api/badge/[owner]/[repo]" },
);
