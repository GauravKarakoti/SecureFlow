import { vi } from 'vitest';

export const mockCreate = vi.fn().mockResolvedValue({
  choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
});

class APIConnectionTimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'APIConnectionTimeoutError';
  }
}

class MockGroq {
  static APIConnectionTimeoutError = APIConnectionTimeoutError;
  static mockCreate = mockCreate;
  chat = { completions: { create: mockCreate } };
  constructor(_opts?: unknown) {}
}

export default MockGroq;
