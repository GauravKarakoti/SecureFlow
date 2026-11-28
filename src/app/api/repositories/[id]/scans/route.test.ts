import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import * as authModule from "@/auth";

const repositoryFindFirst = vi.hoisted(() => vi.fn());
const scanResultFindMany = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    repository: { findFirst: repositoryFindFirst },
    scanResult: { findMany: scanResultFindMany },
  },
}));

vi.mock("@/lib/middleware/rate-limit", () => ({
  TIERS: { STANDARD: { limit: 120, windowSeconds: 60, fallbackStrategy: "fail-open" } },
  withRateLimit: <T>(handler: T): T => handler,
}));

const OWNED_REPO = {
  id: "repo-test-1",
  fullName: "acme/payment-service",
  owner: "acme",
};

const session = (overrides: Record<string, unknown> = {}) =>
  ({
    user: { id: "user-123", email: "alice@example.com" },
    ...overrides,
  }) as never;

const request = (url: string = "http://localhost/api/repositories/repo-test-1/scans") =>
  new Request(url, {
    method: "GET",
    headers: { "x-forwarded-for": "192.0.2.1" },
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authModule.auth).mockResolvedValue(session());
  repositoryFindFirst.mockResolvedValue(OWNED_REPO);
});

describe("GET /api/repositories/[id]/scans route", () => {
  it("returns 401 Unauthorized when session is unauthenticated", async () => {
    vi.mocked(authModule.auth).mockResolvedValue(null);

    const response = await GET(request(), {
      params: Promise.resolve({ id: "repo-test-1" }),
    });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("returns 400 when repositoryId is missing", async () => {
    const response = await GET(new Request("http://localhost/api/repositories/scans") as never, {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Repository ID is required");
  });

  it("returns 404 when repository is not found or not owned by user", async () => {
    repositoryFindFirst.mockResolvedValue(null);

    const response = await GET(request(), {
      params: Promise.resolve({ id: "non-existent-repo" }),
    });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe("Repository not found");
    expect(repositoryFindFirst).toHaveBeenCalledWith({
      where: { id: "non-existent-repo", userId: "user-123" },
      select: { id: true, fullName: true, owner: true },
    });
  });

  it("returns 200 with chronological scans and finding severity counts", async () => {
    const mockScans = [
      {
        id: "scan-1",
        riskScore: 85,
        policyDecision: "BLOCK",
        createdAt: new Date("2026-11-01T10:00:00Z"),
        pullRequest: { id: "pr-1", prNumber: 101, title: "Add auth middleware" },
        findings: [
          { id: "f-1", severity: "CRITICAL", type: "SECRET" },
          { id: "f-2", severity: "HIGH", type: "VULNERABILITY" },
          { id: "f-3", severity: "MEDIUM", type: "MISCONFIG" },
          { id: "f-4", severity: "LOW", type: "MISCONFIG" },
          { id: "f-5", severity: "INFO", type: "MISCONFIG" },
        ],
      },
      {
        id: "scan-2",
        riskScore: 20,
        policyDecision: "PASS",
        createdAt: new Date("2026-11-15T15:30:00Z"),
        pullRequest: { id: "pr-2", prNumber: 102, title: "Remove leaked secret" },
        findings: [
          { id: "f-6", severity: "LOW", type: "MISCONFIG" },
          { id: "f-7", severity: "LOW", type: "MISCONFIG" },
        ],
      },
    ];

    scanResultFindMany.mockResolvedValue(mockScans);

    const response = await GET(request(), {
      params: Promise.resolve({ id: "repo-test-1" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const data = await response.json();
    expect(data.repositoryId).toBe("repo-test-1");
    expect(data.repositoryName).toBe("acme/payment-service");
    expect(data.rangeDays).toBe(30);
    expect(data.totalScans).toBe(2);
    expect(data.scans).toHaveLength(2);

    // Verify first scan severity aggregation
    expect(data.scans[0]).toEqual({
      id: "scan-1",
      createdAt: "2026-11-01T10:00:00.000Z",
      date: "2026-11-01",
      prNumber: 101,
      prTitle: "Add auth middleware",
      riskScore: 85,
      policyDecision: "BLOCK",
      critical: 1,
      high: 1,
      medium: 1,
      low: 1,
      info: 1,
      total: 5,
    });

    // Verify second scan severity aggregation
    expect(data.scans[1]).toEqual({
      id: "scan-2",
      createdAt: "2026-11-15T15:30:00.000Z",
      date: "2026-11-15",
      prNumber: 102,
      prTitle: "Remove leaked secret",
      riskScore: 20,
      policyDecision: "PASS",
      critical: 0,
      high: 0,
      medium: 0,
      low: 2,
      info: 0,
      total: 2,
    });

    expect(scanResultFindMany).toHaveBeenCalledWith({
      where: {
        pullRequest: { repositoryId: "repo-test-1" },
        createdAt: { gte: expect.any(Date) },
      },
      orderBy: { createdAt: "asc" },
      select: expect.any(Object),
    });
  });

  it("handles 7d, 30d, and 90d range selectors properly", async () => {
    scanResultFindMany.mockResolvedValue([]);

    // 7 days
    const res7 = await GET(request("http://localhost/api/repositories/repo-test-1/scans?days=7"), {
      params: Promise.resolve({ id: "repo-test-1" }),
    });
    const data7 = await res7.json();
    expect(data7.rangeDays).toBe(7);

    // 90 days via ?range=90
    const res90 = await GET(
      request("http://localhost/api/repositories/repo-test-1/scans?range=90"),
      { params: Promise.resolve({ id: "repo-test-1" }) },
    );
    const data90 = await res90.json();
    expect(data90.rangeDays).toBe(90);

    // Invalid days defaults to 30
    const resInvalid = await GET(
      request("http://localhost/api/repositories/repo-test-1/scans?days=invalid"),
      { params: Promise.resolve({ id: "repo-test-1" }) },
    );
    const dataInvalid = await resInvalid.json();
    expect(dataInvalid.rangeDays).toBe(30);
  });

  it("resolves repositoryId from query string when params object is empty", async () => {
    scanResultFindMany.mockResolvedValue([]);

    const res = await GET(
      request("http://localhost/api/repositories/scans?repositoryId=repo-test-1"),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.repositoryId).toBe("repo-test-1");
  });
});
