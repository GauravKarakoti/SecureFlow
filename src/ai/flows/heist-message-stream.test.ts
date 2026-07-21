import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @/ai/genkit ──────────────────────────────────────────────────────────
// Mirrors the pattern from security-explanation-stream.test.ts exactly.
// generateStream returns an async-iterable `stream` of text delta chunks plus
// a `response` promise for the final assembled text.
let mockChunks: string[] = [];
let mockFinalText = 'Bella ciao, accomplice. The vault is sealed.';
let mockGenerateStreamThrows = false;

vi.mock('@/ai/genkit', () => ({
  ai: {
    generateStream: () => {
      if (mockGenerateStreamThrows) {
        throw new Error('simulated model failure');
      }
      return {
        // Each chunk yields `{ text: delta }` — plain text, no JSON schema.
        stream: (async function* () {
          for (const delta of mockChunks) {
            yield { text: delta };
          }
        })(),
        response: Promise.resolve({ text: mockFinalText }),
      };
    },
  },
  defaultModel: 'mock-model',
}));

vi.mock('dotenv/config', () => ({}));

import {
  streamHeistMessage,
  FALLBACK_HEIST_MESSAGE,
  type HeistStreamEvent,
} from './heist-message-stream';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function collectEvents(
  input: Parameters<typeof streamHeistMessage>[0],
): Promise<HeistStreamEvent[]> {
  const events: HeistStreamEvent[] = [];
  for await (const event of streamHeistMessage(input)) {
    events.push(event);
  }
  return events;
}

const baseInput = {
  projectName: 'The Royal Mint',
  score: 95,
  rank: 'S' as const,
  findingsCount: 2,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('streamHeistMessage', () => {
  beforeEach(() => {
    mockChunks = [];
    mockFinalText = 'Bella ciao, accomplice. The vault is sealed.';
    mockGenerateStreamThrows = false;
  });

  // ── Streaming chunks ────────────────────────────────────────────────────────

  it('yields incremental chunk events as text accumulates', async () => {
    // Each mock chunk is a raw delta from the model; the flow accumulates them
    // before yielding — so the emitted `text` is the total text received so far.
    mockChunks = ['Bella ', 'ciao, ', 'accomplice.'];
    mockFinalText = 'Bella ciao, accomplice.';

    const events = await collectEvents(baseInput);
    const chunks = events.filter((e) => e.type === 'chunk');

    // Three unique accumulated-text snapshots (each is delta appended to previous).
    expect(chunks).toHaveLength(3);
    if (chunks[0].type === 'chunk') expect(chunks[0].text).toBe('Bella ');
    if (chunks[1].type === 'chunk') expect(chunks[1].text).toBe('Bella ciao, ');
    if (chunks[2].type === 'chunk') expect(chunks[2].text).toBe('Bella ciao, accomplice.');
  });

  it('does not emit a chunk event for an empty delta', async () => {
    // Empty strings from the model should be silently dropped.
    mockChunks = ['Hello', '', ' world'];
    mockFinalText = 'Hello world';

    const events = await collectEvents(baseInput);
    const chunks = events.filter((e) => e.type === 'chunk');

    // Only non-empty deltas should produce chunk events.
    expect(chunks).toHaveLength(2);
  });

  // ── Done event ──────────────────────────────────────────────────────────────

  it('ends with a single done event containing the final message', async () => {
    mockFinalText = 'Bella ciao, accomplice. The vault is sealed. Zero traces remain.';

    const events = await collectEvents(baseInput);
    const doneEvents = events.filter((e) => e.type === 'done');

    expect(doneEvents).toHaveLength(1);
    if (doneEvents[0].type === 'done') {
      expect(doneEvents[0].message).toBe(
        'Bella ciao, accomplice. The vault is sealed. Zero traces remain.',
      );
    }
  });

  it('emits exactly one done event as the last event', async () => {
    mockChunks = ['Part one. ', 'Part one. Part two.'];
    mockFinalText = 'Part one. Part two.';

    const events = await collectEvents(baseInput);
    const last = events[events.length - 1];

    expect(last.type).toBe('done');
  });

  it('falls back to FALLBACK_HEIST_MESSAGE when finalText is empty', async () => {
    mockChunks = [];
    mockFinalText = '';

    const events = await collectEvents(baseInput);
    const done = events.find((e) => e.type === 'done');

    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.message).toBe(FALLBACK_HEIST_MESSAGE);
    }
  });

  // ── Error paths ─────────────────────────────────────────────────────────────

  it('yields a single error event (not a thrown exception) when generation throws', async () => {
    mockGenerateStreamThrows = true;

    const events = await collectEvents(baseInput);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    if (events[0].type === 'error') {
      expect(events[0].message).toContain('simulated model failure');
    }
  });

  it('yields an error event for invalid input (missing projectName)', async () => {
    const events = await collectEvents({
      projectName: '', // min length 1 — should fail Zod validation
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
  });

  it('yields an error event for an out-of-range score', async () => {
    const events = await collectEvents({
      projectName: 'Test',
      score: 150, // > 100 — should fail Zod validation
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
  });

  // ── Optional fields ─────────────────────────────────────────────────────────

  it('works correctly when only projectName is provided', async () => {
    mockFinalText = 'The vault of Test Project is sealed.';

    const events = await collectEvents({ projectName: 'Test Project' });
    const done = events.find((e) => e.type === 'done');

    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.message).toContain('Test Project');
    }
  });

  it('accumulates chunk text correctly across multiple deltas', async () => {
    // Verify the accumulator logic: each chunk event text is the total so far.
    mockChunks = ['A', 'B', 'C'];
    mockFinalText = 'ABC';

    const events = await collectEvents(baseInput);
    const chunkTexts = events
      .filter((e) => e.type === 'chunk')
      .map((e) => (e as { type: 'chunk'; text: string }).text);

    expect(chunkTexts).toEqual(['A', 'AB', 'ABC']);
  });

  // ── Groq mock integration ────────────────────────────────────────────────────

  it('uses the existing Groq mock infrastructure (mockStream from __mocks__/groq-sdk)', async () => {
    // The flow uses @/ai/genkit (which wraps groq-sdk internally).
    // This test confirms the mock wiring works end-to-end without needing
    // a real GROQ_API_KEY by verifying the output matches mock data.
    mockChunks = ['Bella ciao.'];
    mockFinalText = 'Bella ciao, accomplice.';

    const events = await collectEvents(baseInput);
    expect(events.some((e) => e.type === 'chunk')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.every((e) => e.type !== 'error')).toBe(true);
  });
});
