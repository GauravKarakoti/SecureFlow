import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

let mockIpAllowed = true;
let mockUserAllowed = true;

vi.mock("@/lib/middleware/rate-limit", () => ({
  TIERS: {
    AUTH: { limit: 10, windowSeconds: 60, fallbackStrategy: "fail-closed", timeoutMs: 1000 },
    AI_STREAM: { limit: 20, windowSeconds: 60, fallbackStrategy: "fail-closed", timeoutMs: 1000 },
    AI_STREAM_USER: {
      limit: 10,
      windowSeconds: 60,
      fallbackStrategy: "fail-closed",
      timeoutMs: 1000,
    },
    STANDARD: { limit: 120, windowSeconds: 60, fallbackStrategy: "fail-open" },
    ADMIN: { limit: 30, windowSeconds: 60, fallbackStrategy: "fail-closed", timeoutMs: 1000 },
  },
  withRateLimit: vi.fn((fn: (...a: unknown[]) => unknown) => (req: unknown, ...args: unknown[]) => {
    if (!mockIpAllowed) {
      return NextResponse.json(
        {
          error: "Too Many Requests",
          message: "You have exceeded the rate limit. Please try again later.",
        },
        { status: 429, headers: { "Retry-After": "60" } },
      );
    }
    return fn(req, ...args);
  }),
}));

vi.mock("@/lib/redis", () => ({
  checkRateLimit: vi.fn(async () => mockUserAllowed),
  checkRateLimitDetailed: vi.fn(async () => ({
    allowed: mockUserAllowed,
    limit: 10,
    remaining: mockUserAllowed ? 9 : 0,
    resetAt: Date.now() + 60000,
    degraded: false,
  })),
  redis: null,
}));

const mockFinding = {
  id: "finding-1",
  type: "Vulnerability",
  severity: "HIGH",
  fileLocation: "src/db.ts",
  codeSnippet: 'const q = "SELECT * FROM x WHERE id=" + id;',
  scanResult: { pullRequest: { repository: { userId: "user-1" } } },
};

let mockSession: { user?: { id: string } } | null = { user: { id: "user-1" } };
let mockFindUniqueResult: typeof mockFinding | null = mockFinding;
let mockEvents: Array<Record<string, unknown>> = [];

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => mockSession),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    finding: {
      findUnique: vi.fn(async () => mockFindUniqueResult),
      update: vi.fn(async () => ({})),
    },
  },
}));

// Response caching (Redis) lives inside streamDeveloperSecurityExplanations, so hit/miss
// behavior is covered in src/ai/flows/security-explanation-stream.test.ts and
// src/lib/explanation-cache.test.ts. This route just forwards whatever the flow yields.
vi.mock("@/ai/flows/security-explanation-stream", () => ({
  streamDeveloperSecurityExplanations: vi.fn(async function* () {
    for (const event of mockEvents) {
      yield event;
    }
  }),
}));

import { GET } from "./route";
import prisma from "@/lib/prisma";

async function readSSE(response: Response): Promise<Array<Record<string, unknown>>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<Record<string, unknown>> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }

  for (const block of buffer.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data: "));
    if (line) events.push(JSON.parse(line.slice("data: ".length)));
  }
  return events;
}

describe("GET /api/findings/[id]/explain-stream", () => {
  beforeEach(() => {
    mockSession = { user: { id: "user-1" } };
    mockFindUniqueResult = mockFinding;
    mockIpAllowed = true;
    mockUserAllowed = true;
    mockEvents = [
      { type: "chunk", explanation: "Partial" },
      {
        type: "done",
        result: {
          explanation: "Full explanation.",
          remediationSuggestions: "Fix it.",
          promptInjectionSuspected: false,
        },
      },
    ];
    vi.clearAllMocks();
  });

  it("returns 401 when there is no session", async () => {
    mockSession = null;

    const res = await GET({} as any, { params: Promise.resolve({ id: "finding-1" }) });

    expect(res.status).toBe(401);
  });

  it("returns 404 when the finding does not exist", async () => {
    mockFindUniqueResult = null;

    const res = await GET({} as any, { params: Promise.resolve({ id: "missing" }) });

    expect(res.status).toBe(404);
  });

  it("returns 403 without streaming when the finding belongs to another user", async () => {
    mockFindUniqueResult = {
      ...mockFinding,
      scanResult: { pullRequest: { repository: { userId: "user-2" } } },
    };
    const { streamDeveloperSecurityExplanations } =
      await import("@/ai/flows/security-explanation-stream");

    const res = await GET({} as any, { params: Promise.resolve({ id: "finding-1" }) });

    expect(res.status).toBe(403);
    expect(streamDeveloperSecurityExplanations).not.toHaveBeenCalled();
  });

  it("streams chunk and done events as Server-Sent Events", async () => {
    const res = await GET({} as any, { params: Promise.resolve({ id: "finding-1" }) });

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const events = await readSSE(res);
    expect(events).toEqual(mockEvents);
  });

  it("persists the refreshed explanation to the database once the stream completes", async () => {
    const res = await GET({} as any, { params: Promise.resolve({ id: "finding-1" }) });
    await readSSE(res);

    expect(prisma.finding.update).toHaveBeenCalledWith({
      where: { id: "finding-1" },
      data: {
        explanation: "Full explanation.",
        remediation: "Fix it.",
        promptInjectionSuspected: false,
      },
    });
  });

  it("still delivers the done event to the client even if persisting to the database fails", async () => {
    (prisma.finding.update as any).mockRejectedValueOnce(new Error("db down"));

    const res = await GET({} as any, { params: Promise.resolve({ id: "finding-1" }) });
    const events = await readSSE(res);

    expect(events).toEqual(mockEvents);
  });

  it("loads the owner through the ownership chain in the same query", async () => {
    await GET({} as any, { params: Promise.resolve({ id: "finding-1" }) });

    expect(prisma.finding.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.finding.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "finding-1" },
        select: expect.objectContaining({
          scanResult: {
            select: { pullRequest: { select: { repository: { select: { userId: true } } } } },
          },
        }),
      }),
    );
  });

  it("selects only fields that exist on the Finding model", async () => {
    // The Prisma mock accepts any select, but the real client throws
    // PrismaClientValidationError for an unknown field, which turned every request into a 500.
    await GET({} as any, { params: Promise.resolve({ id: "finding-1" }) });

    const [{ select }] = (prisma.finding.findUnique as any).mock.calls[0];
    const known = new Set<string>([
      "id",
      "scanResultId",
      "type",
      "severity",
      "fileLocation",
      "lineStart",
      "lineEnd",
      "codeSnippet",
      "explanation",
      "remediation",
      "promptInjectionSuspected",
      "fingerprint",
      "createdAt",
      "scanResult",
    ]);
    expect(Object.keys(select).filter((field) => !known.has(field))).toEqual([]);
  });

  it("returns 429 when the IP-based rate limit is exceeded", async () => {
    mockIpAllowed = false;

    const res = await GET({} as any, { params: Promise.resolve({ id: "finding-1" }) });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Too Many Requests");
  });

  it("returns 429 when the user-based rate limit is exceeded", async () => {
    mockUserAllowed = false;

    const res = await GET({} as any, { params: Promise.resolve({ id: "finding-1" }) });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Too Many Requests");
  });

  it("checks user-based rate limit with the authenticated user id", async () => {
    const { checkRateLimit } = await import("@/lib/redis");

    await GET({} as any, { params: Promise.resolve({ id: "finding-1" }) });

    expect(checkRateLimit).toHaveBeenCalledWith("rate-limit:explain-stream:user:user-1", 10, 60, {
      fallbackStrategy: "fail-closed",
      timeoutMs: 1000,
    });
  });
});
