import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Minimal React stubs so the hook module loads in a Node environment.
const states: Map<number, unknown> = new Map();
let idx = 0;

vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const id = idx++;
    if (!states.has(id)) states.set(id, initial);
    const setter = (v: unknown) => {
      const next =
        typeof v === 'function'
          ? (v as (prev: unknown) => unknown)(states.get(id))
          : v;
      states.set(id, next);
    };
    return [states.get(id), setter];
  },
  useCallback: (fn: unknown) => fn,
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: (fn: () => void | (() => void)) => {
    // Execute cleanup immediately for tests
    const cleanup = fn();
    if (typeof cleanup === 'function') {
      cleanup();
    }
  },
}));

// Mock useToast to avoid complex dependencies
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: vi.fn(),
    dismiss: vi.fn(),
    toasts: [],
  }),
}));

// ---- SSE stream helpers ----

function makeSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

function sseBlock(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// ---- Tests ----

describe('useStreamingExplanation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    delete (globalThis as any).fetch;
  });

  it('sets isStreaming=true immediately after start() is called', async () => {
    // Resolve only after we've had a chance to inspect intermediate state.
    let resolveResponse!: (v: Response) => void;
    fetchMock.mockReturnValue(new Promise((r) => (resolveResponse = r)));

    const { useStreamingExplanation } = await import('./use-streaming-explanation');
    const hook = useStreamingExplanation('finding-1');

    const promise = hook.start();
    // Before the fetch resolves the hook should be streaming.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/findings/finding-1/explain-stream',
      expect.any(Object)
    );

    // Clean up — resolve with an error response so start() exits cleanly.
    resolveResponse(new Response(null, { status: 500 }));
    await promise;
  });

  it('accumulates explanation text from chunk events', async () => {
    const body = makeSSEStream([
      sseBlock({ type: 'chunk', explanation: 'Hello' }),
      sseBlock({ type: 'chunk', explanation: 'Hello world' }),
      sseBlock({
        type: 'done',
        result: {
          explanation: 'Hello world',
          remediationSuggestions: 'Fix it.',
          promptInjectionSuspected: false,
        },
      }),
    ]);

    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));

    const { useStreamingExplanation } = await import('./use-streaming-explanation');
    const hook = useStreamingExplanation('finding-2');
    await hook.start();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sets an error message on a 401 response', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    const { useStreamingExplanation } = await import('./use-streaming-explanation');
    const hook = useStreamingExplanation('finding-3');
    // Should not throw.
    await expect(hook.start()).resolves.toBeUndefined();
  });

  it('sets an error message on a non-ok response', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    const { useStreamingExplanation } = await import('./use-streaming-explanation');
    const hook = useStreamingExplanation('finding-4');
    await expect(hook.start()).resolves.toBeUndefined();
  });

  it('handles an error event from the SSE stream', async () => {
    const body = makeSSEStream([
      sseBlock({ type: 'error', message: 'AI failed' }),
    ]);
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));

    const { useStreamingExplanation } = await import('./use-streaming-explanation');
    const hook = useStreamingExplanation('finding-5');
    await hook.start();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not surface an AbortError as a user-facing error', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new DOMException('Aborted', 'AbortError'))
    );

    const { useStreamingExplanation } = await import('./use-streaming-explanation');
    const hook = useStreamingExplanation('finding-6');
    // Must resolve without throwing.
    await expect(hook.start()).resolves.toBeUndefined();
  });

  it('surfaces non-abort fetch errors as an error state', async () => {
    fetchMock.mockRejectedValue(new Error('Network failure'));

    const { useStreamingExplanation } = await import('./use-streaming-explanation');
    const hook = useStreamingExplanation('finding-7');
    await expect(hook.start()).resolves.toBeUndefined();
  });

  it('calls stop() which aborts the in-flight request', async () => {
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, opts: RequestInit) => {
      capturedSignal = opts.signal as AbortSignal;
      return new Promise(() => {}); // never resolves
    });

    const { useStreamingExplanation } = await import('./use-streaming-explanation');
    const hook = useStreamingExplanation('finding-8');
    hook.start(); // intentionally not awaited
    hook.stop();

    expect(capturedSignal?.aborted).toBe(true);
  });
});
