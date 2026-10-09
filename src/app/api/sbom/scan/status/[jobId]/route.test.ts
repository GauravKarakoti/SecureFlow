import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  authMock,
  scanJobFindUniqueMock,
  repositoryFindFirstMock,
  auditLogFindFirstMock,
  getSbomJobStatusMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  scanJobFindUniqueMock: vi.fn(),
  repositoryFindFirstMock: vi.fn(),
  auditLogFindFirstMock: vi.fn(),
  getSbomJobStatusMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));

vi.mock("@/lib/prisma", () => ({
  default: {
    scanJob: { findUnique: scanJobFindUniqueMock },
    repository: { findFirst: repositoryFindFirstMock },
    auditLog: { findFirst: auditLogFindFirstMock },
  },
}));

vi.mock("@/lib/queue/sbomQueue", () => ({
  getSbomJobStatus: getSbomJobStatusMock,
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
  TIERS: { STANDARD: { limit: 120, windowSeconds: 60 } },
  withRateLimit: <T>(handler: T): T => handler,
}));

import { GET } from "./route";

function makeGetRequest() {
  return new Request("http://localhost/api/sbom/scan/status/sj-123", {
    method: "GET",
  }) as any;
}

describe("GET /api/sbom/scan/status/[jobId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-123" } });
  });

  it("returns 401 Unauthorized when session is missing", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(makeGetRequest(), { params: Promise.resolve({ jobId: "sj-123" }) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 404 when scanJob does not exist", async () => {
    scanJobFindUniqueMock.mockResolvedValue(null);

    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ jobId: "sj-nonexistent" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Scan job not found" });
  });

  it("returns 404 when caller does not own the repository attached to the scan", async () => {
    scanJobFindUniqueMock.mockResolvedValue({ id: "sj-123", repositoryId: "repo-other" });
    repositoryFindFirstMock.mockResolvedValue(null); // not owned by user-123

    const res = await GET(makeGetRequest(), { params: Promise.resolve({ jobId: "sj-123" }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Scan job not found" });
  });

  it("returns 404 for a standalone scan enqueued by another user", async () => {
    scanJobFindUniqueMock.mockResolvedValue({ id: "sj-standalone", repositoryId: null });
    auditLogFindFirstMock.mockResolvedValue(null); // no enqueued audit by user-123

    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ jobId: "sj-standalone" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Scan job not found" });
  });

  it("returns 200 with status info when authorized via repository ownership", async () => {
    scanJobFindUniqueMock.mockResolvedValue({ id: "sj-123", repositoryId: "repo-mine" });
    repositoryFindFirstMock.mockResolvedValue({ id: "repo-mine" });

    const mockStatusInfo = {
      scanJobId: "sj-123",
      status: "COMPLETED",
      totalFiles: 1,
      scannedFiles: 1,
      vulnerabilitiesFound: 1,
      result: {
        scanId: "sj-123",
        status: "VULNERABLE",
        totalDependencies: 2,
        vulnerabilities: [{ cveId: "CVE-1" }],
      },
      error: null,
      queuedAt: new Date(),
      startedAt: new Date(),
      completedAt: new Date(),
    };
    getSbomJobStatusMock.mockResolvedValue(mockStatusInfo);

    const res = await GET(makeGetRequest(), { params: Promise.resolve({ jobId: "sj-123" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(await res.json()).toMatchObject({
      scanJobId: "sj-123",
      status: "COMPLETED",
      vulnerabilitiesFound: 1,
    });
  });

  it("returns 200 with status info when authorized via standalone scan audit", async () => {
    scanJobFindUniqueMock.mockResolvedValue({ id: "sj-standalone", repositoryId: null });
    auditLogFindFirstMock.mockResolvedValue({ id: "audit-mine" });

    const mockStatusInfo = {
      scanJobId: "sj-standalone",
      status: "PROCESSING",
      totalFiles: 1,
      scannedFiles: 0,
      vulnerabilitiesFound: 0,
      result: null,
      error: null,
      queuedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    };
    getSbomJobStatusMock.mockResolvedValue(mockStatusInfo);

    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ jobId: "sj-standalone" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      scanJobId: "sj-standalone",
      status: "PROCESSING",
    });
  });
});
