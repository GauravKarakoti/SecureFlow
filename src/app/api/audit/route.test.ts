import { describe, it, expect, vi, beforeEach } from "vitest";

const { authMock, auditLogFindMany, auditLogCount } = vi.hoisted(() => ({
  authMock: vi.fn(),
  auditLogFindMany: vi.fn(),
  auditLogCount: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));

vi.mock("@/lib/prisma", () => ({
  default: {
    auditLog: {
      findMany: auditLogFindMany,
      count: auditLogCount,
    },
  },
}));

vi.mock("@/lib/middleware/error-handler", () => {
  class AppError extends Error {
    statusCode: number;
    constructor(msg: string, code = 400) {
      super(msg);
      this.statusCode = code;
    }
  }

  return {
    AppError,
    withErrorHandler:
      (fn: (...args: unknown[]) => unknown) =>
      async (...args: unknown[]) => {
        try {
          return await fn(...args);
        } catch (err: unknown) {
          const e = err as { statusCode?: number; message?: string };
          return new Response(JSON.stringify({ error: e.message }), {
            status: e.statusCode ?? 500,
            headers: { "content-type": "application/json" },
          });
        }
      },
  };
});

vi.mock("@/lib/middleware/rate-limit", () => ({
  withRateLimit: <T>(handler: T): T => handler,
}));

import { GET } from "@/app/api/audit/route";

describe("GET /api/audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-123" } });
  });

  const makeLog = (id: string, timestamp: Date) => ({
    id,
    userId: "user-123",
    action: "POLICY_EVALUATION",
    resource: "repo#1",
    decision: "ALLOWED",
    metadata: { rule: "no-secrets" },
    timestamp,
  });

  it("rejects unauthenticated requests with 401", async () => {
    authMock.mockResolvedValue(null);
    const req = new Request("http://localhost:9002/api/audit");
    const res = await GET(req as any);
    expect(res.status).toBe(401);
  });

  it("returns first page with default limit 20 and nextCursor when more logs exist", async () => {
    const logs = Array.from({ length: 21 }, (_, i) =>
      makeLog(`log-${i}`, new Date(Date.now() - i * 1000)),
    );
    auditLogFindMany.mockResolvedValue(logs);
    auditLogCount.mockResolvedValue(45);

    const req = new Request("http://localhost:9002/api/audit");
    const res = await GET(req as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.logs).toHaveLength(20);
    expect(body.total).toBe(45);
    expect(body.nextCursor).toBeTruthy();
    expect(auditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 21,
        orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      }),
    );
  });

  it("fetches the next page using cursor", async () => {
    const logs = Array.from({ length: 11 }, (_, i) =>
      makeLog(`log-${i + 20}`, new Date(Date.now() - (i + 20) * 1000)),
    );
    auditLogFindMany.mockResolvedValue(logs);
    auditLogCount.mockResolvedValue(45);

    const cursor = Buffer.from(
      JSON.stringify({ timestamp: new Date().toISOString(), id: "log-19" }),
    ).toString("base64url");

    const req = new Request(`http://localhost:9002/api/audit?cursor=${cursor}&limit=10`);
    const res = await GET(req as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.logs).toHaveLength(10);
    expect(body.nextCursor).toBeTruthy();
    expect(auditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 11,
        where: expect.objectContaining({
          userId: "user-123",
          OR: expect.arrayContaining([expect.objectContaining({ timestamp: expect.anything() })]),
        }),
      }),
    );
  });

  it("returns null nextCursor on the last page", async () => {
    const logs = Array.from({ length: 5 }, (_, i) =>
      makeLog(`log-${i}`, new Date(Date.now() - i * 1000)),
    );
    auditLogFindMany.mockResolvedValue(logs);
    auditLogCount.mockResolvedValue(5);

    const req = new Request("http://localhost:9002/api/audit?limit=10");
    const res = await GET(req as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.logs).toHaveLength(5);
    expect(body.nextCursor).toBeNull();
    expect(body.total).toBe(5);
  });

  it("clamps limit above maximum to 100", async () => {
    auditLogFindMany.mockResolvedValue([]);
    auditLogCount.mockResolvedValue(0);

    const req = new Request("http://localhost:9002/api/audit?limit=500");
    const res = await GET(req as any);
    expect(res.status).toBe(200);

    expect(auditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 101, // 100 + 1
      }),
    );
  });

  it("filters by action, decision and search", async () => {
    auditLogFindMany.mockResolvedValue([]);
    auditLogCount.mockResolvedValue(0);

    const req = new Request(
      "http://localhost:9002/api/audit?action=POLICY_EVALUATION&decision=BLOCKED&search=secret",
    );
    const res = await GET(req as any);
    expect(res.status).toBe(200);

    expect(auditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-123",
          action: "POLICY_EVALUATION",
          decision: "BLOCKED",
          OR: [
            { action: { contains: "secret", mode: "insensitive" } },
            { resource: { contains: "secret", mode: "insensitive" } },
            { decision: { contains: "secret", mode: "insensitive" } },
          ],
        }),
      }),
    );
  });
});
