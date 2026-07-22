import { type NextRequest, NextResponse } from 'next/server';
import {
  streamHeistMessage,
  FALLBACK_HEIST_MESSAGE,
  type HeistMessageInput,
} from '@/ai/flows/heist-message-stream';

/**
 * GET /api/heist-transmission
 *
 * Query params (all optional except the presence of at least `project`):
 *   project       — name of the audited project
 *   score         — numeric security score (0–100)
 *   rank          — clearance tier letter (S | A | B | C | D)
 *   findingsCount — number of findings logged
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
export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = req.nextUrl;

  const project = searchParams.get('project') ?? 'The Royal Mint';
  const scoreRaw = searchParams.get('score');
  const rank = searchParams.get('rank') ?? undefined;
  const findingsRaw = searchParams.get('findingsCount') ?? undefined;

  const score =
    scoreRaw !== null && !Number.isNaN(Number(scoreRaw))
      ? Number(scoreRaw)
      : undefined;

  const findingsCount =
    findingsRaw !== undefined && !Number.isNaN(Number(findingsRaw))
      ? Number(findingsRaw)
      : undefined;

  const validRanks = new Set(['S', 'A', 'B', 'C', 'D']);
  const cleanRank =
    rank && validRanks.has(rank.toUpperCase())
      ? (rank.toUpperCase() as HeistMessageInput['rank'])
      : undefined;

  const input: HeistMessageInput = {
    projectName: project,
    ...(score !== undefined && { score }),
    ...(cleanRank && { rank: cleanRank }),
    ...(findingsCount !== undefined && { findingsCount }),
  };

  // ── Build the SSE response stream ─────────────────────────────────────────
  const encoder = new TextEncoder();

  const readableStream = new ReadableStream({
    async start(controller) {
      function send(event: Record<string, unknown>): void {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }

      try {
        for await (const event of streamHeistMessage(input)) {
          send(event);

          // Close the stream once we've delivered a terminal event.
          if (event.type === 'done' || event.type === 'error') {
            controller.close();
            return;
          }
        }

        // If the generator completed without emitting done/error (shouldn't happen
        // with the current implementation, but guard defensively).
        send({ type: 'done', message: FALLBACK_HEIST_MESSAGE });
        controller.close();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown streaming error.';
        send({ type: 'error', message });
        controller.close();
      }
    },
  });

  return new Response(readableStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Prevent Vercel / proxies from buffering the stream.
      'X-Accel-Buffering': 'no',
    },
  });
}

// Opt out of Next.js static caching — every request must stream live.
export const dynamic = 'force-dynamic';
