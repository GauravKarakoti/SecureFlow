import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { streamDeveloperSecurityExplanations } from '@/ai/flows/security-explanation-stream';
import { withRateLimit, TIERS } from '@/lib/middleware/rate-limit';
import { checkRateLimit } from '@/lib/redis';
import { ratelimit } from '@/lib/rate-limit';
import { streamManager } from '@/lib/sse/streamManager';

export const dynamic = 'force-dynamic';

/**
 * Streams a live-regenerated AI explanation for a single finding as Server-Sent Events.
 * Rate-limited via both IP-based token bucket (`withRateLimit`) and per-user token bucket (`checkRateLimit`).
 * Includes error boundary catching for Groq SDK timeout or rate-limit errors.
 *
 * Each event is a JSON-encoded line of the shape emitted by streamDeveloperSecurityExplanations
 * (`{"type":"chunk",...}`, `{"type":"done",...}`, or `{"type":"error",...}`), so the client can
 * render the explanation as it arrives instead of waiting for the full response - this is the
 * whole point of the endpoint (cut perceived latency for the AI explanation UI).
 *
 * Ownership is checked the same way the findings dashboard page checks it: the finding must
 * belong to a scan result, on a pull request, on a repository owned by the signed-in user.
 */
async function handler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  // Upstash sliding-window rate limit check if UPSTASH_REDIS_REST_URL is set
  if (ratelimit) {
    const { success } = await ratelimit.limit(`explain-stream:${userId}`);
    if (!success) {
      return NextResponse.json(
        { error: 'Too Many Requests', message: 'You have exceeded the rate limit. Please try again later.' },
        { status: 429, headers: { 'Retry-After': '60' } }
      );
    }
  }

  // User-based token bucket: stricter than IP limit, keyed per authenticated user
  const userAllowed = await checkRateLimit(
    `rate-limit:explain-stream:user:${userId}`,
    TIERS.AI_STREAM_USER.limit,
    TIERS.AI_STREAM_USER.windowSeconds,
    { fallbackStrategy: TIERS.AI_STREAM_USER.fallbackStrategy, timeoutMs: TIERS.AI_STREAM_USER.timeoutMs }
  );
  if (!userAllowed) {
    return NextResponse.json(
      { error: 'Too Many Requests', message: 'You have exceeded the rate limit. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(TIERS.AI_STREAM_USER.windowSeconds) } }
    );
  }

  const { id } = await params;

// FIX: First, check if the finding exists at all to prevent BOLA/IDOR masking
    const existingFinding = await prisma.finding.findUnique({
      where: { id },
    });

    if (!existingFinding) {
      return NextResponse.json({ error: "Finding not found" }, { status: 404 });
    }

    // Next, verify that the authenticated user actually owns this finding
    const finding = await prisma.finding.findFirst({
      where: {
        id,
        scanResult: { pullRequest: { repository: { userId } } },
      },
    });

    if (!finding) {
      return NextResponse.json({ error: "Forbidden: You do not have access to this finding" }, { status: 403 });
    }

  const encoder = new TextEncoder();
  const { id: connectionId, signal: abortSignal } = streamManager.register(request.signal, 'explain-stream');

  let closed = false;

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown): void => {
        if (closed || abortSignal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // The reader is already gone; stop enqueueing so the next send doesn't
          // throw "Invalid state: Controller is already closed".
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

      try {
        for await (const event of streamDeveloperSecurityExplanations(
          {
            findingType: finding.type,
            severity: finding.severity,
            // The Finding model doesn't persist the original scanner-generated `description` -
            // only the AI's resulting explanation/remediation are stored. type/severity/
            // fileLocation/codeSnippet still give the model full context for re-analysis.
            description: '',
            fileLocation: finding.fileLocation,
            codeSnippet: finding.codeSnippet || '',
          },
          { signal: abortSignal },
        )) {
          if (closed || abortSignal.aborted) {
            finish();
            return;
          }

          send(event);

          if (event.type === 'done') {
            // Persist the refreshed explanation so a page reload (or the batch webhook view)
            // reflects the same text the user just watched stream in, rather than going stale.
            try {
              await prisma.finding.update({
                where: { id: finding.id },
                data: {
                  explanation: event.result.explanation,
                  remediation: event.result.remediationSuggestions,
                  promptInjectionSuspected: event.result.promptInjectionSuspected,
                },
              });
            } catch {
              // Non-fatal: the client already has the live result, a failed persist just means
              // the next full page load will show the previous stored explanation instead.
            }
          }
        }
      } catch (err) {
        // A disconnect surfaces here as an abort — that's expected teardown, not an error.
        if (!abortSignal.aborted) {
          send({
            type: 'error',
            message: err instanceof Error ? err.message : 'AI generation failed.',
          });
        }
      } finally {
        finish();
      }
    },

    cancel() {
      // Reader (client) went away — abort the generator so it stops pulling tokens.
      closed = true;
      streamManager.unregister(connectionId);
    },
  });

  return new Response(readable as unknown as BodyInit, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// IP-based token bucket wraps the entire handler — outermost guard, fail-closed
export const GET = withRateLimit(
  handler as (req: NextRequest, ...args: unknown[]) => Promise<NextResponse>,
  { ...TIERS.AI_STREAM, keyPrefix: 'explain-stream:ip' }
) as typeof handler;
