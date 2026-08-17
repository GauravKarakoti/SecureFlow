import { type NextRequest } from "next/server";
import {
  streamHeistMessage,
  FALLBACK_HEIST_MESSAGE,
  type HeistMessageInput,
} from "@/ai/flows/heist-message-stream";

/**
 * GET /api/heist-transmission
 *
 * Query params (all optional):
 *   project       — name of the audited project (defaults to "The Royal Mint")
 *   score         — numeric security score (0–100)
 *   rank          — clearance tier letter (S | A | B | C | D)
 *   findingsCount — number of findings logged (non-negative)
 *
 * Response: text/event-stream (SSE)
 *
 * Event shapes:
 *   data: {"type":"chunk","text":"<accumulated text so far>"}
 *   data: {"type":"done","message":"<full final message>"}
 *   data: {"type":"error","message":"<reason>"}
 *
 * The client should close the EventSource once it receives a `done` or `error` event.
 *
 * Keeps page.tsx a pure RSC (so OG/Twitter metadata generation is unaffected) while
 * allowing the "use client" HeistTransmission component to consume the stream over HTTP.
 */

/** Upper bound on the project name interpolated into the model prompt. */
const MAX_PROJECT_NAME_LENGTH = 120;

/** Matches the schema in heist-message-stream. */
const MIN_SCORE = 0;
const MAX_SCORE = 100;
const MAX_FINDINGS_COUNT = 100_000;

const VALID_RANKS = new Set(["S", "A", "B", "C", "D"]);

/**
 * Parse a query parameter as an integer within `[min, max]`, or return
 * `undefined`.
 *
 * `Number()` alone was not enough: `Number('')` is `0`, so `?score=` silently
 * became a real score of zero, and `Infinity`, `1e999`, negatives and floats
 * all passed the `Number.isNaN` check and went straight into the prompt.
 */
export function parseBoundedInt(raw: string | null, min: number, max: number): number | undefined {
  if (raw === null) return undefined;

  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;

  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) return undefined;

  return rounded;
}

/** Build the validated generator input from the request's query string. */
export function parseHeistParams(searchParams: URLSearchParams): HeistMessageInput {
  const rawProject = searchParams.get("project")?.trim();
  const projectName = rawProject ? rawProject.slice(0, MAX_PROJECT_NAME_LENGTH) : "The Royal Mint";

  const score = parseBoundedInt(searchParams.get("score"), MIN_SCORE, MAX_SCORE);
  const findingsCount = parseBoundedInt(searchParams.get("findingsCount"), 0, MAX_FINDINGS_COUNT);

  const rawRank = searchParams.get("rank")?.trim().toUpperCase();
  const rank =
    rawRank && VALID_RANKS.has(rawRank) ? (rawRank as HeistMessageInput["rank"]) : undefined;

  return {
    projectName,
    ...(score !== undefined && { score }),
    ...(rank && { rank }),
    ...(findingsCount !== undefined && { findingsCount }),
  };
}

/**
 * Build the SSE body for a validated input.
 *
 * Exported so the disconnect behaviour can be tested without standing up a
 * request: cancelling the returned stream is exactly what a browser closing its
 * EventSource does.
 */
export function createHeistStream(
  input: HeistMessageInput,
  upstreamSignal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  // Aborts the model call as soon as the client is gone.
  const controllerAbort = new AbortController();

  if (upstreamSignal) {
    if (upstreamSignal.aborted) controllerAbort.abort();
    else upstreamSignal.addEventListener("abort", () => controllerAbort.abort(), { once: true });
  }

  let closed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      /**
       * Enqueue an event, or do nothing once the stream is gone.
       *
       * Previously this called `controller.enqueue` unguarded. After the client
       * disconnected that threw `TypeError: Invalid state: Controller is
       * already closed`, which landed in the catch below — where the first
       * thing the handler did was `send()` again, throwing a second time. The
       * error event was never delivered and `controller.close()` never ran.
       */
      const send = (event: Record<string, unknown>): void => {
        if (closed || controllerAbort.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // The consumer went away between our check and the enqueue.
          closed = true;
        }
      };

      const finish = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by a cancel() racing with us — nothing to do.
        }
      };

      // The request was already gone before we started — don't call the model
      // at all, and close so the reader is never left hanging.
      if (controllerAbort.signal.aborted) {
        finish();
        return;
      }

      try {
        for await (const event of streamHeistMessage(input, {
          signal: controllerAbort.signal,
        })) {
          if (closed || controllerAbort.signal.aborted) {
            finish();
            return;
          }

          send(event);

          // Close the stream once we've delivered a terminal event.
          if (event.type === "done" || event.type === "error") {
            finish();
            return;
          }
        }

        // If the generator completed without emitting done/error (it returns
        // early on abort, and defensively otherwise), close cleanly.
        if (!controllerAbort.signal.aborted) {
          send({ type: "done", message: FALLBACK_HEIST_MESSAGE });
        }
        finish();
      } catch (err) {
        if (controllerAbort.signal.aborted) {
          finish();
          return;
        }

        const message = err instanceof Error ? err.message : "Unknown streaming error.";
        send({ type: "error", message });
        finish();
      }
    },

    /**
     * Called when the client disconnects. Without this the generator kept
     * pulling tokens from Groq for a reader that had already gone away.
     */
    cancel() {
      closed = true;
      controllerAbort.abort();
    },
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  const input = parseHeistParams(req.nextUrl.searchParams);

  return new Response(createHeistStream(input, req.signal), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Prevent Vercel / proxies from buffering the stream.
      "X-Accel-Buffering": "no",
    },
  });
}

// Opt out of Next.js static caching — every request must stream live.
export const dynamic = "force-dynamic";