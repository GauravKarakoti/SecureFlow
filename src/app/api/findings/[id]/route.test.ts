/**
 * Tests for GET /api/findings/[id], PATCH /api/findings/[id], DELETE /api/findings/[id]
 * Issue #1465
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  authMock,
  findingFindFirstMock,
  findingFindUniqueMock,
  findingUpdateMock,
  findingDeleteMock,
  findingTriageUpsertMock,
  auditLogCreateMock,
  checkRateLimitDetailedMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  findingFindFirstMock: vi.fn(),
  findingFindUniqueMock: vi.fn(),
  findingUpdateMock: vi.fn(),
  findingDeleteMock: vi.fn(),
  findingTriageUpsertMock: vi.fn(),
  auditLogCreateMock: vi.fn(),
  checkRateLimitDetailedMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));

vi.mock("@/lib/prisma", () => ({
  default: {
    finding: {
      findFirst: findingFindFirstMock,
      findUnique: findingFindUniqueMock,
      update: findingUpdateMock,
      delete: findingDeleteMock,
    },
    findingTriage: {
      upsert: findingTriageUpsertMock,
    },
    auditLog: {
      create: auditLogCreateMock,
    },
  },
}));

vi.mock("@/lib/redis", () => ({
  checkRateLimitDetailed: checkRateLimitDetailedMock,
}));

vi.mock("@/lib/middleware/rate-limit", () => ({
  withRateLimit: <T>(handler: T): T => handler,
  TIERS: {
    STANDARD: { limit: 120, windowSeconds: 60, fallbackStrategy: "fail-open" },
    ADMIN: { limit: 30, windowSeconds: 60, fallbackStrategy: "fail-closed", timeoutMs: 1000 },
  },
  buildRateLimitHeaders: () => ({
    "X-RateLimit-Limit": "30",
    "X-RateLimit-Remaining": "0",
    "X-RateLimit-Reset": "9999999999",
  }),
  secondsUntilReset: () => 45,
}));

import { GET, PATCH, DELETE } from "./route";

// ── Shared fixture ────────────────────────────────────────────────────────────

const FULL_FINDING = {
  id: "finding-1",
  type: "VULNERABILITY",
  severity: "HIGH",
  fileLocation: "src/lib/auth.ts:42",
  lineStart: 42,
  lineEnd: 45,
  codeSnippet: "eval(userInput)",
  explanation: "Remote code execution via eval",
  remediation: "Remove eval usage",
  promptInjectionSuspected: false,
  fingerprint: "fp-abc123",
  complianceTags: ["SOC2"],
  createdAt: new Date("2026-01-01"),
  remediationPatch: null,
  scanResult: {
    id: "scan-1",
    riskScore: 80,
    policyDecision: "BLOCK",
    createdAt: new Date("2026-01-01"),
    pullRequest: {
      id: "pr-1",
      prNumber: 42,
      title: "Feature branch",
      state: "OPEN",
      repositoryId: "repo-1",
    },
  },
};

const OWNERSHIP_FINDING = {
  id: "finding-1",
  fingerprint: "fp-abc123",
  scanResult: { pullRequest: { repositoryId: "repo-1" } },
};

describe("GET /api/findings/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimitDetailedMock.mockResolvedValue({
      allowed: true,
      limit: 120,
      remaining: 119,
      resetAt: Date.now() + 60000,
      degraded: false,
    });
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValueOnce(null);
    const req = new NextRequest("http://localhost/api/findings/finding-1");
    const res = await GET(req, { params: Promise.resolve({ id: "finding-1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 404 when finding not found or not owned", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValueOnce(null);
    const req = new NextRequest("http://localhost/api/findings/missing");
    const res = await GET(req, { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.message ?? body.error).toMatch(/not found/i);
  });

  it("returns 200 with full finding details", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValueOnce(FULL_FINDING);
    const req = new NextRequest("http://localhost/api/findings/finding-1");
    const res = await GET(req, { params: Promise.resolve({ id: "finding-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("finding-1");
    expect(body.severity).toBe("HIGH");
    expect(body.scanResult.pullRequest.prNumber).toBe(42);
  });

  it("sets Cache-Control: private, no-store on success", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValueOnce(FULL_FINDING);
    const req = new NextRequest("http://localhost/api/findings/finding-1");
    const res = await GET(req, { params: Promise.resolve({ id: "finding-1" }) });
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });
});

describe("PATCH /api/findings/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimitDetailedMock.mockResolvedValue({
      allowed: true,
      limit: 120,
      remaining: 115,
      resetAt: Date.now() + 60000,
      degraded: false,
    });
    auditLogCreateMock.mockResolvedValue({});
    findingUpdateMock.mockResolvedValue({ id: "finding-1" });
    findingTriageUpsertMock.mockResolvedValue({});
    findingFindFirstMock.mockResolvedValue(FULL_FINDING);
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValueOnce(null);
    const req = new NextRequest("http://localhost/api/findings/finding-1", {
      method: "PATCH",
      body: JSON.stringify({ triageStatus: "RESOLVED" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "finding-1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 400 when no update fields are provided", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    const req = new NextRequest("http://localhost/api/findings/finding-1", {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "finding-1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid triageStatus", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    const req = new NextRequest("http://localhost/api/findings/finding-1", {
      method: "PATCH",
      body: JSON.stringify({ triageStatus: "INVALID_STATUS" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "finding-1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message ?? body.error).toMatch(/triageStatus/i);
  });

  it("returns 400 for invalid severity", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    const req = new NextRequest("http://localhost/api/findings/finding-1", {
      method: "PATCH",
      body: JSON.stringify({ severity: "SUPER_HIGH" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "finding-1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message ?? body.error).toMatch(/severity/i);
  });

  it("returns 404 when finding not owned", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValueOnce(null);
    const req = new NextRequest("http://localhost/api/findings/not-mine", {
      method: "PATCH",
      body: JSON.stringify({ triageStatus: "RESOLVED" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "not-mine" }) });
    expect(res.status).toBe(404);
  });

  it("returns 429 when user rate limit exceeded", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    checkRateLimitDetailedMock.mockResolvedValueOnce({
      allowed: false,
      limit: 120,
      remaining: 0,
      resetAt: Date.now() + 60000,
      degraded: false,
    });
    const req = new NextRequest("http://localhost/api/findings/finding-1", {
      method: "PATCH",
      body: JSON.stringify({ severity: "LOW" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "finding-1" }) });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("updates triageStatus and returns 200", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValueOnce(OWNERSHIP_FINDING);
    findingFindFirstMock.mockResolvedValueOnce({ ...FULL_FINDING, severity: "HIGH" });
    const req = new NextRequest("http://localhost/api/findings/finding-1", {
      method: "PATCH",
      body: JSON.stringify({ triageStatus: "RESOLVED" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "finding-1" }) });
    expect(res.status).toBe(200);
    expect(findingTriageUpsertMock).toHaveBeenCalledOnce();
    expect(auditLogCreateMock).toHaveBeenCalledOnce();
  });

  it("updates severity and returns 200", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValueOnce(OWNERSHIP_FINDING);
    findingFindFirstMock.mockResolvedValueOnce({ ...FULL_FINDING, severity: "CRITICAL" });
    const req = new NextRequest("http://localhost/api/findings/finding-1", {
      method: "PATCH",
      body: JSON.stringify({ severity: "CRITICAL" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "finding-1" }) });
    expect(res.status).toBe(200);
    expect(findingUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { severity: "CRITICAL" } }),
    );
  });

  it("returns 400 when body is invalid JSON", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    const req = new NextRequest("http://localhost/api/findings/finding-1", {
      method: "PATCH",
      body: "not-json{{{",
      headers: { "Content-Type": "application/json" },
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "finding-1" }) });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/findings/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimitDetailedMock.mockResolvedValue({
      allowed: true,
      limit: 30,
      remaining: 29,
      resetAt: Date.now() + 60000,
      degraded: false,
    });
    auditLogCreateMock.mockResolvedValue({});
    findingDeleteMock.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValueOnce(null);
    const req = new NextRequest("http://localhost/api/findings/finding-1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "finding-1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 404 when finding not found or not owned", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValueOnce(null);
    const req = new NextRequest("http://localhost/api/findings/not-mine", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "not-mine" }) });
    expect(res.status).toBe(404);
  });

  it("returns 204 and deletes the finding", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValueOnce({ id: "finding-1" });
    const req = new NextRequest("http://localhost/api/findings/finding-1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "finding-1" }) });
    expect(res.status).toBe(204);
    expect(findingDeleteMock).toHaveBeenCalledWith({ where: { id: "finding-1" } });
    expect(auditLogCreateMock).toHaveBeenCalledOnce();
  });

  it("returns 429 when delete rate limit exceeded", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    checkRateLimitDetailedMock.mockResolvedValueOnce({
      allowed: false,
      limit: 30,
      remaining: 0,
      resetAt: Date.now() + 60000,
      degraded: false,
    });
    const req = new NextRequest("http://localhost/api/findings/finding-1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "finding-1" }) });
    expect(res.status).toBe(429);
  });
});
