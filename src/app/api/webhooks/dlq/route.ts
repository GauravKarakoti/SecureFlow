import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { listDlqEntries, purgeDlqEntry, purgeAllDlq } from "@/lib/webhooks/dlq";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    return NextResponse.json({ error: "Unauthorized: Admin access required" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const webhookId = searchParams.get("webhookId") || undefined;
  const status = (searchParams.get("status") as any) || undefined;
  const circuitBrokenParam = searchParams.get("circuitBroken");
  const circuitBroken = circuitBrokenParam !== null ? circuitBrokenParam === "true" : undefined;
  const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined;
  const offset = searchParams.get("offset") ? Number(searchParams.get("offset")) : undefined;

  const entries = listDlqEntries({
    webhookId,
    status,
    circuitBroken,
    limit,
    offset,
  });

  return NextResponse.json({
    total: entries.length,
    entries,
  });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    return NextResponse.json({ error: "Unauthorized: Admin access required" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (id) {
    const success = purgeDlqEntry(id);
    if (!success) {
      return NextResponse.json({ error: `DLQ entry "${id}" not found` }, { status: 404 });
    }
    return NextResponse.json({ success: true, purgedId: id });
  }

  const purgedCount = purgeAllDlq();
  return NextResponse.json({ success: true, purgedCount });
}
