import { type NextRequest, NextResponse } from "next/server";
import { loadLeaderboard } from "@/app/leaderboard/aggregate";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import {
  DEFAULT_LEADERBOARD_LIMIT,
  getLeaderboardBroadcaster,
  type LeaderboardEvent,
} from "@/lib/leaderboard/broadcaster";

export const dynamic = "force-dynamic";

/**
 * SSE comment sent between updates.
 *
 * A connection that is idle for the full poll interval can be dropped by a proxy
 * with a shorter read timeout; a comment line keeps it warm without being
 * delivered to the client as a message.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * GET /api/leaderboard
 *
 * Supports two modes:
 * 1. SSE Stream: Requested with `stream=true` or `Accept: text/event-stream`.
 *    Streams updated leaderboard standings every 15 seconds.
 * 2. Standard JSON: Returns current top 50 leaderboard standings as a single JSON object.
 */
async function handler(req: NextRequest): Promise<Response> {
  const { searchParams } = req.nextUrl;
  const wantsStream =
    searchParams.get("stream") === "true" ||
    req.headers.get("accept")?.includes("text/event-stream");

  if (!wantsStream) {
    try {
      const contributors = await loadLeaderboard(DEFAULT_LEADERBOARD_LIMIT);
      return NextResponse.json({ contributors, timestamp: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load leaderboard data";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  const encoder = new TextEncoder();

  // One poll shared by every connected client, instead of one timer and one
  // aggregation query per connection.
  const broadcaster = getLeaderboardBroadcaster((limit) => loadLeaderboard(limit));

  /**
   * Bridges `start()` and `cancel()`, which cannot otherwise share state because
   * `cancel()` receives no reference to what `start()` created. Declared per
   * request — a module-level ref would be overwritten by concurrent connections.
   */
  const cleanupRef: { current: (() => void) | null } = { current: null };

  const readableStream = new ReadableStream({
    async start(controller) {
      let unsubscribe: (() => void) | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let closed = false;

      /**
       * Release everything this connection owns.
       *
       * Idempotent, because it is reachable from three places that can each fire
       * for the same connection: the stream's `cancel()`, the request's `abort`
       * event, and the already-aborted check below.
       */
      const teardown = () => {
        if (closed) return;
        closed = true;

        unsubscribe?.();
        unsubscribe = null;

        if (heartbeat !== null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }

        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      // Exposed so `cancel()` — the path that leaked before — can tear down too.
      cleanupRef.current = teardown;

      const write = (chunk: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          // The consumer is gone. Previously this was swallowed and the timer
          // kept running; now it ends the connection.
          teardown();
          return false;
        }
      };

      const send = (event: LeaderboardEvent) => {
        const payload =
          event.type === "update"
            ? { contributors: event.contributors, timestamp: event.timestamp }
            : { error: event.message };
        write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      // A signal that aborted before `start()` ran never fires its listener, so
      // the old code scheduled a timer that nothing would ever clear.
      if (req.signal.aborted) {
        teardown();
        return;
      }

      req.signal.addEventListener("abort", teardown, { once: true });

      unsubscribe = broadcaster.subscribe(send);

      // Serve the cached snapshot immediately when one exists, so a client
      // joining mid-cycle does not stare at an empty board for a full interval.
      const cached = broadcaster.cachedEvent;
      if (cached) {
        send(cached);
      } else {
        await broadcaster.refreshNow();
      }

      heartbeat = setInterval(() => {
        write(": keep-alive\n\n");
      }, HEARTBEAT_INTERVAL_MS);
      (heartbeat as unknown as { unref?: () => void }).unref?.();
    },

    cancel() {
      // The normal teardown path for a closed tab or a dropped proxy connection.
      // Without this the per-connection timer outlived the connection forever.
      cleanupRef.current?.();
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

export const GET = withRateLimit(
  handler as any,
  { ...TIERS.STANDARD, keyPrefix: 'leaderboard' }
);
