import { NextResponse } from "next/server";
import { runHealthCheck } from "@/lib/health-check";

/**
 * GET /api/health
 *
 * Returns a structured health report with per-component status.
 * Use from monitoring tools (UptimeRobot, Datadog, k8s probes).
 *
 * HTTP status mirrors the aggregate: 200 for healthy/degraded, 503 for down.
 */
export async function GET() {
  const report = await runHealthCheck();
  const status = report.status === "down" ? 503 : 200;

  return NextResponse.json(report, {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
