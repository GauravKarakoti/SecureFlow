import { vi } from 'vitest';

export class NextRequest {
  headers: Headers;
  constructor(url: string, init?: RequestInit) {
    this.headers = new Headers((init?.headers as HeadersInit) ?? {});
  }
}

export const NextResponse = {
  json: vi.fn((body: unknown, init?: ResponseInit) => ({
    body,
    status: init?.status ?? 200,
    headers: new Headers((init?.headers as HeadersInit) ?? {}),
  })),
};
