/**
 * Mock Groq SDK Module (Security Audit Cleaned - #1303)
 *
 * This mock contains purely synthetic data and ensures that no real API keys,
 * production credentials, or internal infrastructure tokens are hardcoded or leaked.
 */
import { vi } from "vitest";

/** Safe synthetic placeholder API key for test suites. */
export const SAFE_MOCK_GROQ_API_KEY = "mock_api_key";

/**
 * Asserts that a provided API key is purely a synthetic mock token
 * and prevents accidental exposure of live production credentials in test suites.
 */
export function assertSafeMockCredentials(apiKey?: string): boolean {
  if (!apiKey) return true;
  // Disallow real/live looking production keys that lack mock/test designations
  if (
    apiKey.startsWith("gsk_") &&
    !apiKey.toLowerCase().includes("mock") &&
    !apiKey.toLowerCase().includes("test")
  ) {
    throw new Error(
      "[SECURITY AUDIT #1303] Potentially live or sensitive Groq API key detected in mock suite!",
    );
  }
  return true;
}

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
  finalText: "Bella ciao, accomplice. The vault is sealed.",
  /** If true, the async-iterable throws on first iteration. */
  throws: false,
  /** If set, the async-iterable throws this specific error on first iteration. */
  throwError: null as Error | null,

  /** Returns an AsyncIterable<{ choices: [{ delta: { content: string } }] }> */
  build(): AsyncIterable<{ choices: [{ delta: { content: string } }] }> {
    const { chunks, throws, throwError } = mockStream;
    return {
      [Symbol.asyncIterator]: async function* () {
        if (throwError) {
          throw throwError;
        }
        if (throws) {
          throw new Error("simulated stream failure");
        }
        for (const text of chunks) {
          yield { choices: [{ delta: { content: text } }] };
        }
      },
    };
  },
};

/** Resets mockStream to its default (empty, non-throwing) state. */
export function resetMockStream(): void {
  mockStream.chunks = [];
  mockStream.finalText = "Bella ciao, accomplice. The vault is sealed.";
  mockStream.throws = false;
  mockStream.throwError = null;
}

// ── Named LLM failure simulators ─────────────────────────────────────────────
//
// Use these in tests to configure mockCreate for specific failure states
// without constructing error objects by hand each time.
//
// Usage:
//   import { simulateRateLimit, simulateMalformedJSON, simulatePromptInjectionYes, resetMockCreate } from '__mocks__/groq-sdk';
//
//   beforeEach(resetMockCreate);
//
//   it('handles 429', () => {
//     simulateRateLimit();
//     // ... call code under test
//   });

/** Resets mockCreate to the default happy-path response (empty findings). */
export function resetMockCreate(): void {
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
  });
}

/**
 * Configures mockCreate to reject with an HTTP 429 rate-limit error,
 * matching the shape that groq-sdk throws (Error with `.status = 429`).
 */
export function simulateRateLimit(): void {
  mockCreate.mockRejectedValue(Object.assign(new Error("Rate limit reached"), { status: 429 }));
}

/**
 * Configures mockStream to throw an HTTP 429 rate-limit error on first iteration,
 * simulating a rate-limit hit mid-stream for the streaming flows.
 */
export function simulateStreamRateLimit(): void {
  mockStream.throwError = Object.assign(new Error("Rate limit reached"), { status: 429 });
}

/**
 * Configures mockStream to throw a network timeout error on first iteration,
 * simulating a connection timeout mid-stream for the streaming flows.
 */
export function simulateStreamTimeout(): void {
  const err = new Error("Connection timed out");
  err.name = "APIConnectionTimeoutError";
  mockStream.throwError = err;
}

/**
 * Configures mockStream to yield a chunk whose content is not valid JSON,
 * exercising the malformed-output handling path in streaming callers.
 */
export function simulateMalformedStreamJSON(): void {
  mockStream.chunks = ["not valid json {{{{"];
  mockStream.finalText = "not valid json {{{{";
}

/**
 * Configures mockCreate to reject with a network timeout error,
 * matching the shape that groq-sdk throws (APIConnectionTimeoutError).
 */
export function simulateTimeout(): void {
  const err = new Error("Connection timed out");
  err.name = "APIConnectionTimeoutError";
  mockCreate.mockRejectedValue(err);
}

/**
 * Configures mockCreate to resolve with a response whose content is not
 * valid JSON, exercising the malformed-output handling path in callers.
 */
export function simulateMalformedJSON(): void {
  mockCreate.mockResolvedValue({
    choices: [{ message: { content: "not valid json {{{{" } }],
  });
}

/**
 * Configures mockCreate to return a prompt-injection confirmation ("YES")
 * from the secondary LLM injection-check call in security-helpers.
 */
export function simulatePromptInjectionYes(): void {
  mockCreate.mockResolvedValue({
    choices: [{ message: { content: "YES" } }],
  });
}

/**
 * Configures mockCreate to return a prompt-injection denial ("NO")
 * from the secondary LLM injection-check call in security-helpers.
 */
export function simulatePromptInjectionNo(): void {
  mockCreate.mockResolvedValue({
    choices: [{ message: { content: "NO" } }],
  });
}

class APIConnectionTimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "APIConnectionTimeoutError";
  }
}

class MockGroq {
  static APIConnectionTimeoutError = APIConnectionTimeoutError;
  static mockCreate = mockCreate;
  static mockStream = mockStream;
  chat = { completions: { create: mockCreate } };
  apiKey: string;

  constructor(opts?: { apiKey?: string; [key: string]: unknown }) {
    if (opts?.apiKey) {
      assertSafeMockCredentials(opts.apiKey);
    }
    this.apiKey = SAFE_MOCK_GROQ_API_KEY;
  }
}

export default MockGroq;
