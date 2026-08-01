import { type NextRequest, NextResponse } from "next/server";
import { loadLeaderboard } from "@/app/leaderboard/aggregate";

export const dynamic = "force-dynamic";

/**
 * GET /api/leaderboard
 *
 * Supports two modes:
 * 1. SSE Stream: Requested with `stream=true` or `Accept: text/event-stream`.
 *    Streams updated leaderboard standings every 15 seconds.
 * 2. Standard JSON: Returns current top 50 leaderboard standings as a single JSON object.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = req.nextUrl;
  const wantsStream =
    searchParams.get("stream") === "true" ||
    req.headers.get("accept")?.includes("text/event-stream");

  if (!wantsStream) {
    try {
      const contributors = await loadLeaderboard(50);
      return NextResponse.json({ contributors, timestamp: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load leaderboard data";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  const encoder = new TextEncoder();

  const readableStream = new ReadableStream({
    async start(controller) {
      let intervalId: ReturnType<typeof setInterval> | null = null;

      function send(data: Record<string, unknown>): void {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Stream controller might be closed
        }
      }

      const pushLeaderboard = async () => {
        try {
          const contributors = await loadLeaderboard(50);
          send({ contributors, timestamp: Date.now() });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Stream update failed";
          send({ error: message });
        }
      };

      // Push initial state immediately
      await pushLeaderboard();

      // Periodic update every 15s
      intervalId = setInterval(() => {
        void pushLeaderboard();
      }, 15000);

      req.signal.addEventListener("abort", () => {
        if (intervalId !== null) {
          clearInterval(intervalId);
          intervalId = null;
        }
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
  });

  return new Response(readableStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
