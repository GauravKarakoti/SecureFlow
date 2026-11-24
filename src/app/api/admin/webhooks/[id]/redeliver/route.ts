import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { redeliverWebhookDelivery } from "@/lib/webhooks/redeliver";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    return NextResponse.json({ error: "Unauthorized: Admin access required" }, { status: 403 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Delivery ID is required" }, { status: 400 });
  }

  try {
    const result = await redeliverWebhookDelivery(id, {
      userId: session.user.id,
      userName: session.user.name || session.user.email || undefined,
    });

    if (!result.success) {
      return NextResponse.json(
        { error: result.message, deliveryId: result.deliveryId },
        { status: result.statusCode || 500 },
      );
    }

    return NextResponse.json({
      success: true,
      deliveryId: result.deliveryId,
      message: result.message,
      statusCode: result.statusCode,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Internal server error" }, { status: 500 });
  }
}
