import { NextResponse } from "next/server";
import { getDetailedLandingMetrics } from "@/lib/metrics/landing-stats";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const metrics = await getDetailedLandingMetrics();
    return NextResponse.json(metrics, {
      status: 200,
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (error: any) {
    console.error("[API Metrics Landing] Error fetching metrics:", error);
    return NextResponse.json(
      { error: "Failed to retrieve security metrics" },
      { status: 500 }
    );
  }
}
