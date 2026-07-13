import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFinding = {
  id: 'finding-1',
  type: 'Vulnerability',
  severity: 'HIGH',
  fileLocation: 'src/db.ts',
  codeSnippet: 'const q = "SELECT * FROM x WHERE id=" + id;',
};

let mockSession: { user?: { id: string } } | null = { user: { id: 'user-1' } };
let mockFindFirstResult: typeof mockFinding | null = mockFinding;
let mockEvents: Array<Record<string, unknown>> = [];

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => mockSession),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    finding: {
      findFirst: vi.fn(async () => mockFindFirstResult),
      update: vi.fn(async () => ({})),
    },
  },
}));

vi.mock('@/ai/flows/security-explanation-stream', () => ({
  streamDeveloperSecurityExplanations: vi.fn(async function* () {
    for (const event of mockEvents) {
      yield event;
    }
  }),
}));

import { GET } from './route';
import prisma from '@/lib/prisma';

async function readSSE(response: Response): Promise<Array<Record<string, unknown>>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: Array<Record<string, unknown>> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }

  for (const block of buffer.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (line) events.push(JSON.parse(line.slice('data: '.length)));
  }
  return events;
}

describe('GET /api/findings/[id]/explain-stream', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'user-1' } };
    mockFindFirstResult = mockFinding;
    mockEvents = [
      { type: 'chunk', explanation: 'Partial' },
      {
        type: 'done',
        result: {
          explanation: 'Full explanation.',
          remediationSuggestions: 'Fix it.',
          promptInjectionSuspected: false,
        },
      },
    ];
    vi.clearAllMocks();
  });

  it('returns 401 when there is no session', async () => {
    mockSession = null;

    const res = await GET({} as any, { params: Promise.resolve({ id: 'finding-1' }) });

    expect(res.status).toBe(401);
  });

  it('returns 404 when the finding does not belong to the user (or does not exist)', async () => {
    mockFindFirstResult = null;

    const res = await GET({} as any, { params: Promise.resolve({ id: 'missing' }) });

    expect(res.status).toBe(404);
  });

  it('streams chunk and done events as Server-Sent Events', async () => {
    const res = await GET({} as any, { params: Promise.resolve({ id: 'finding-1' }) });

    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const events = await readSSE(res);
    expect(events).toEqual(mockEvents);
  });

  it('persists the refreshed explanation to the database once the stream completes', async () => {
    const res = await GET({} as any, { params: Promise.resolve({ id: 'finding-1' }) });
    await readSSE(res);

    expect(prisma.finding.update).toHaveBeenCalledWith({
      where: { id: 'finding-1' },
      data: {
        explanation: 'Full explanation.',
        remediation: 'Fix it.',
        promptInjectionSuspected: false,
      },
    });
  });

  it('still delivers the done event to the client even if persisting to the database fails', async () => {
    (prisma.finding.update as any).mockRejectedValueOnce(new Error('db down'));

    const res = await GET({} as any, { params: Promise.resolve({ id: 'finding-1' }) });
    const events = await readSSE(res);

    expect(events).toEqual(mockEvents);
  });

  it('scopes the finding lookup to the signed-in user via the ownership chain', async () => {
    await GET({} as any, { params: Promise.resolve({ id: 'finding-1' }) });

    expect(prisma.finding.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'finding-1',
        scanResult: { pullRequest: { repository: { userId: 'user-1' } } },
      },
    });
  });
});
