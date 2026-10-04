import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { runHealthCheck, type HealthReport } from "@/lib/health-check";

/**
 * GET /api/health
 *
 * Returns a structured health report with per-component status.
 * Use from monitoring tools (UptimeRobot, Datadog, k8s probes).
 *
 * HTTP status mirrors the aggregate: 200 for healthy/degraded, 503 for down.
 *
 * The endpoint is public, so anonymous callers get each component's status and
 * latency but not its `message`. Those messages are raw driver errors — Prisma's
 * include the database host and port, ioredis's describe the client's retry
 * configuration — which is reconnaissance for anyone who asks and no use to an
 * uptime monitor, which only reads the status. Signed-in users (the
 * /dashboard/status page refreshes from here) still see them.
 */
export async function GET() {
  const report = await runHealthCheck();
  const status = report.status === "down" ? 503 : 200;

  return NextResponse.json((await isSignedIn()) ? report : withoutMessages(report), {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

async function isSignedIn(): Promise<boolean> {
  try {
    const session = await auth();
    return Boolean(session?.user?.id);
  } catch {
    // A health check must answer even when the session layer cannot.
    return false;
  }
}

function withoutMessages(report: HealthReport): HealthReport {
  return {
    ...report,
    components: report.components.map(({ name, status, latencyMs }) => ({
      name,
      status,
      latencyMs,
    })),
  };
}
