import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { batchReplayDlq } from "@/lib/webhooks/dlq";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    return NextResponse.json({ error: "Unauthorized: Admin access required" }, { status: 403 });
  }

  let ids: string[] | undefined;
  try {
    const body = await req.json();
    if (Array.isArray(body?.ids)) {
      ids = body.ids;
    }
  } catch {
    // Body is optional; replays all quarantined if omitted
  }

  try {
    const result = await batchReplayDlq(ids);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Batch replay failed" }, { status: 500 });
  }
}
