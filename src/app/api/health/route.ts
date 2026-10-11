import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { runHealthCheck, type HealthReport } from "@/lib/health-check";

/**
 * GET /api/health
 *
 * Returns a structured health report with per-component status.
 * Use from monitoring tools (UptimeRobot, Datadog, k8s probes).
 * Supports SSE streaming (stream=true or Accept: text/event-stream) for real-time dashboard status.
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
export async function GET(req?: NextRequest) {
  const wantsStream =
    req?.nextUrl?.searchParams?.get("stream") === "true" ||
    req?.headers?.get("accept")?.includes("text/event-stream");

  const signedIn = await isSignedIn();

  if (wantsStream) {
    const encoder = new TextEncoder();
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const stream = new ReadableStream({
      async start(controller) {
        const sendReport = async () => {
          if (closed) return;
          try {
            const report = await runHealthCheck();
            const payload = signedIn ? report : withoutMessages(report);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          } catch {
            // Ignore temporary probe failures during streaming
          }
        };

        // Send initial report immediately
        await sendReport();

        // Stream updates periodically every 10 seconds
        intervalId = setInterval(sendReport, 10_000);

        const teardown = () => {
          if (closed) return;
          closed = true;
          if (intervalId) clearInterval(intervalId);
          try {
            controller.close();
          } catch {
            // Controller already closed
          }
        };

        req?.signal?.addEventListener("abort", teardown);
      },
      cancel() {
        closed = true;
        if (intervalId) clearInterval(intervalId);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  const report = await runHealthCheck();
  const status = report.status === "down" ? 503 : 200;

  return NextResponse.json(signedIn ? report : withoutMessages(report), {
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
