import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  listWebhookDeliveries,
  getWebhookDeliveryStats,
  getRecentWebhookRepositories,
} from "@/lib/webhooks/delivery-recorder";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    return NextResponse.json({ error: "Unauthorized: Admin access required" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const repository = searchParams.get("repository") || undefined;
  const outcome = searchParams.get("outcome") || undefined;
  const reasonCode = searchParams.get("reasonCode") || undefined;
  const search = searchParams.get("search") || undefined;
  const limit = parseInt(searchParams.get("limit") || "50", 10);
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  try {
    const [deliveriesResult, stats, repositories] = await Promise.all([
      listWebhookDeliveries({
        repository,
        outcome,
        reasonCode,
        search,
        limit,
        offset,
      }),
      getWebhookDeliveryStats(7),
      getRecentWebhookRepositories(7),
    ]);

    return NextResponse.json({
      ...deliveriesResult,
      stats,
      repositories,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to fetch webhook deliveries" },
      { status: 500 },
    );
  }
}
