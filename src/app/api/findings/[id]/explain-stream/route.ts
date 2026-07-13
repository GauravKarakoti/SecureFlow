import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { streamDeveloperSecurityExplanations } from '@/ai/flows/security-explanation-stream';

export const dynamic = 'force-dynamic';

/**
 * Streams a live-regenerated AI explanation for a single finding as Server-Sent Events.
 *
 * Each event is a JSON-encoded line of the shape emitted by streamDeveloperSecurityExplanations
 * (`{"type":"chunk",...}`, `{"type":"done",...}`, or `{"type":"error",...}`), so the client can
 * render the explanation as it arrives instead of waiting for the full response - this is the
 * whole point of the endpoint (cut perceived latency for the AI explanation UI).
 *
 * Ownership is checked the same way the findings dashboard page checks it: the finding must
 * belong to a scan result, on a pull request, on a repository owned by the signed-in user.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const { id } = await params;

  const finding = await prisma.finding.findFirst({
    where: {
      id,
      scanResult: { pullRequest: { repository: { userId } } },
    },
  });

  if (!finding) {
    return NextResponse.json({ error: 'Finding not found' }, { status: 404 });
  }

  const encoder = new TextEncoder();

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      try {
        for await (const event of streamDeveloperSecurityExplanations({
          findingType: finding.type,
          severity: finding.severity,
          // The Finding model doesn't persist the original scanner-generated `description` -
          // only the AI's resulting explanation/remediation are stored. type/severity/
          // fileLocation/codeSnippet still give the model full context for re-analysis.
          description: '',
          fileLocation: finding.fileLocation,
          codeSnippet: finding.codeSnippet || '',
        })) {
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
        send({
          type: 'error',
          message: err instanceof Error ? err.message : 'AI generation failed.',
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
