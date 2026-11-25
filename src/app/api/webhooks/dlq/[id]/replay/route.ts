import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { replayDlqEntry } from "@/lib/webhooks/dlq";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    return NextResponse.json({ error: "Unauthorized: Admin access required" }, { status: 403 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "DLQ entry ID is required" }, { status: 400 });
  }

  try {
    const result = await replayDlqEntry(id);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Redelivery failed", result },
        { status: result.statusCode || 502 },
      );
    }
    return NextResponse.json({ success: true, result });
  } catch (err: any) {
    const isNotFound = err?.message?.includes("not found");
    return NextResponse.json(
      { error: err?.message || "Replay failed" },
      { status: isNotFound ? 404 : 500 },
    );
  }
}
