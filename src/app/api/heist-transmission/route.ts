import { type NextRequest, NextResponse } from "next/server";
import {
  streamHeistMessage,
  FALLBACK_HEIST_MESSAGE,
  type HeistMessageInput,
} from "@/ai/flows/heist-message-stream";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import { screenProjectName } from "@/ai/flows/heist-prompt-guard";
import {
  getTransmissionCache,
  transmissionKey,
  type TransmissionCache,
} from "@/lib/heist/transmission-cache";
import { streamManager } from "@/lib/sse/streamManager";

const MIN_SCORE = 0;
const MAX_SCORE = 100;
const MAX_FINDINGS_COUNT = 100_000;
const VALID_RANKS = new Set(["S", "A", "B", "C", "D"]);

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

/**
 * Parse and screen the query string.
 *
 * `project` is the only free-text parameter and this endpoint is public and
 * unauthenticated, so it is cleaned and screened here rather than being sliced
 * to 120 characters and forwarded (#643). `screenProjectName` strips control
 * characters and zero-width splitters, collapses whitespace, enforces the
 * length cap, and replaces anything matching an injection pattern with the
 * default name.
 */
export function parseHeistParams(searchParams: URLSearchParams): HeistMessageInput {
  const { projectName } = screenProjectName(searchParams.get("project"));

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
 * Replay a cached transmission as if it had just been generated.
 *
 * The client renders `chunk` events with a typewriter effect and only treats
 * `done` as authoritative, so a cache hit emits one `chunk` carrying the whole
 * text followed by `done`. The page looks the same; it simply cost nothing.
 */
export function cachedTransmissionEvents(message: string): Record<string, unknown>[] {
  return [
    { type: "chunk", text: message },
    { type: "done", message, cached: true },
  ];
}

export interface HeistStreamOptions {
  /** Injected so tests can supply their own cache instead of the shared one. */
  cache?: TransmissionCache;
}

export function createHeistStream(
  input: HeistMessageInput,
  upstreamSignal?: AbortSignal,
  options: HeistStreamOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const { id: connectionId, signal: abortSignal } = streamManager.register(upstreamSignal, "heist-transmission");
  const cache = options.cache ?? getTransmissionCache();
  const cacheKey = transmissionKey(input);

  let closed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>): void => {
        if (closed || abortSignal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const finish = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
        streamManager.unregister(connectionId);
      };

      if (abortSignal.aborted) {
        finish();
        return;
      }

      // A share link that circulates is a thousand callers with one request
      // each, which the per-IP rate limit does nothing about. Identical
      // parameters produce identical decorative text, so serve it from memory.
      const cached = cache.get(cacheKey);
      if (cached) {
        for (const event of cachedTransmissionEvents(cached)) send(event);
        finish();
        return;
      }

      try {
        for await (const event of streamHeistMessage(input, {
          signal: abortSignal,
        })) {
          if (closed || abortSignal.aborted) {
            finish();
            return;
          }

          send(event);

          if (event.type === "done") {
            // A guarded transmission is the static fallback, not a generated
            // one — caching it would pin the fallback to a key whose next
            // caller might have supplied a perfectly good name.
            if (!event.guarded) cache.set(cacheKey, event.message);
            finish();
            return;
          }

          if (event.type === "error") {
            finish();
            return;
          }
        }

        if (!abortSignal.aborted) {
          send({ type: "done", message: FALLBACK_HEIST_MESSAGE });
        }
        finish();
      } catch (err) {
        if (abortSignal.aborted) {
          finish();
          return;
        }

        const message = err instanceof Error ? err.message : "Unknown streaming error.";
        send({ type: "error", message });
        finish();
      }
    },

    cancel() {
      closed = true;
      streamManager.unregister(connectionId);
    },
  });
}

// Ensure the return type matches `Promise<NextResponse>`
async function handleGet(req: NextRequest): Promise<NextResponse> {
  const input = parseHeistParams(req.nextUrl.searchParams);

  // Return a `NextResponse` instead of `Response`
  return new NextResponse(createHeistStream(input, req.signal), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// Rate limit the AI streaming route using the correct TIERS property
export const GET = withRateLimit(handleGet, {
  ...TIERS.AI_STREAM,
  keyPrefix: "heist:transmission:get",
});

export const dynamic = "force-dynamic";