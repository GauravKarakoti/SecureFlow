import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import { withRateLimit } from "@/lib/middleware/rate-limit";
import {
  parseLimit,
  decodeCursor,
  encodeCursor,
  buildCursorWhere,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "@/lib/pagination/cursor";

export const dynamic = "force-dynamic";

const handler = withErrorHandler(
  async function GET(req: NextRequest) {
    const session = await auth();
    if (!session?.user?.id) {
      throw new AppError("Unauthorized", 401);
    }
    const userId = session.user.id;

    const { searchParams } = new URL(req.url);
    const limit = parseLimit(searchParams.get("limit"), DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const cursor = searchParams.get("cursor");
    const action = searchParams.get("action") || undefined;
    const decision = searchParams.get("decision") || undefined;
    const search = searchParams.get("search")?.trim() || undefined;

    const decodedCursor = decodeCursor(cursor);

    const baseWhere: any = { userId };
    if (action) baseWhere.action = action;
    if (decision) baseWhere.decision = decision;
    if (search) {
      baseWhere.OR = [
        { action: { contains: search, mode: "insensitive" } },
        { resource: { contains: search, mode: "insensitive" } },
        { decision: { contains: search, mode: "insensitive" } },
      ];
    }

    const where: any = {
      ...baseWhere,
      ...buildCursorWhere(decodedCursor, "timestamp"),
    };

    const [rawItems, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: [{ timestamp: "desc" }, { id: "desc" }],
        take: limit + 1,
      }),
      prisma.auditLog.count({ where: baseWhere }),
    ]);

    const hasMore = rawItems.length > limit;
    const items = hasMore ? rawItems.slice(0, limit) : rawItems;
    const nextCursor =
      hasMore && items.length > 0
        ? encodeCursor({
            createdAt: items[items.length - 1].timestamp,
            id: items[items.length - 1].id,
          })
        : null;

    return NextResponse.json({
      logs: items,
      total,
      nextCursor,
    });
  },
  { routeLabel: "GET /api/audit" },
);

export const GET = withRateLimit(handler, {
  limit: 120,
  windowSeconds: 60,
  keyPrefix: "audit:list",
  fallbackStrategy: "fail-open",
});
