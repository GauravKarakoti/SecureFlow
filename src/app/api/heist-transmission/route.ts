import { NextResponse } from 'next/server';
import { globalStreamManager } from '../../../../lib/sse/streamManager';

export async function POST(request: Request) {
  const streamId = crypto.randomUUID();
  
  // AbortController to pass down to LLM provider (e.g. Groq)
  const llmAbortController = new AbortController();
  globalStreamManager.registerStream(streamId, llmAbortController);

  // Attach listener to request signal to catch client disconnects
  request.signal.addEventListener('abort', () => {
    globalStreamManager.abortStream(streamId);
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Simulated LLM generation loop
        for (let i = 0; i < 10; i++) {
          if (llmAbortController.signal.aborted) {
            break;
          }
          controller.enqueue(encoder.encode(`data: Token ${i}\n\n`));
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        controller.close();
      } catch (err: any) {
        if (!llmAbortController.signal.aborted) {
          controller.error(err);
        }
      } finally {
        globalStreamManager.deregisterStream(streamId);
      }
    },
    cancel() {
      globalStreamManager.abortStream(streamId);
    }
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
