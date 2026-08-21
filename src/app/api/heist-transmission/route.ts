import { type NextRequest, NextResponse } from "next/server";
import {
  streamHeistMessage,
  FALLBACK_HEIST_MESSAGE,
  type HeistMessageInput,
} from "@/ai/flows/heist-message-stream";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";

const MAX_PROJECT_NAME_LENGTH = 120;
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

export function createHeistStream(
  input: HeistMessageInput,
  upstreamSignal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const controllerAbort = new AbortController();

  if (upstreamSignal) {
    if (upstreamSignal.aborted) controllerAbort.abort();
    else upstreamSignal.addEventListener("abort", () => controllerAbort.abort(), { once: true });
  }

  let closed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>): void => {
        if (closed || controllerAbort.signal.aborted) return;
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
      };

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

          if (event.type === "done" || event.type === "error") {
            finish();
            return;
          }
        }

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

    cancel() {
      closed = true;
      controllerAbort.abort();
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