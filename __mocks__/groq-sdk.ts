import { vi } from 'vitest';

export const mockCreate = vi.fn().mockResolvedValue({
  choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
});

/**
 * mockStream — configures what the async-iterable text stream returned by
 * Groq's `chat.completions.create({ stream: true })` yields in tests.
 *
 * Usage (in a test file):
 *   import { mockStream } from '__mocks__/groq-sdk';
 *   mockStream.chunks = ['Bella ', 'Bella ciao'];
 *   mockStream.finalText = 'Bella ciao, accomplice.';
 */
export const mockStream = {
  /** Incremental text snapshots (each one is the text-so-far, like a real stream). */
  chunks: [] as string[],
  /** Full text to return in the final `done` synthetic event (unused by mock itself). */
  finalText: 'Bella ciao, accomplice. The vault is sealed.',
  /** If true, the async-iterable throws on first iteration. */
  throws: false,

  /** Returns an AsyncIterable<{ choices: [{ delta: { content: string } }] }> */
  build(): AsyncIterable<{ choices: [{ delta: { content: string } }] }> {
    const { chunks, throws } = mockStream;
    return {
      [Symbol.asyncIterator]: async function* () {
        if (throws) {
          throw new Error('simulated stream failure');
        }
        for (const text of chunks) {
          yield { choices: [{ delta: { content: text } }] };
        }
      },
    };
  },
};

class APIConnectionTimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'APIConnectionTimeoutError';
  }
}

class MockGroq {
  static APIConnectionTimeoutError = APIConnectionTimeoutError;
  static mockCreate = mockCreate;
  static mockStream = mockStream;
  chat = { completions: { create: mockCreate } };
  constructor(_opts?: unknown) {}
}

export default MockGroq;
