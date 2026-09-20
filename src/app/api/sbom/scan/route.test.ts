import { describe, it, expect, vi, beforeEach } from "vitest";

const { authMock, enqueueSbomScanMock, mockPrisma } = vi.hoisted(() => ({
  authMock: vi.fn(),
  enqueueSbomScanMock: vi.fn(),
  mockPrisma: {
    repository: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/auth", () => ({ auth: authMock }));

vi.mock("@/lib/prisma", () => ({ default: mockPrisma }));

vi.mock("@/lib/queue/sbomQueue", () => ({
  enqueueSbomScan: enqueueSbomScanMock,
  MAX_SBOM_BYTES: 1024 * 1024,
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

import { POST, MAX_REQUEST_BYTES } from "./route";

function makePostRequest(body: unknown, headerOverrides: Record<string, string | null> = {}) {
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  for (const [key, val] of Object.entries(headerOverrides)) {
    if (val !== null) {
      headers[key] = val;
    }
  }

  const req = new Request("http://localhost/api/sbom/scan", {
    method: "POST",
    headers,
    body: serialized,
  });

  return req as any;
}

describe("POST /api/sbom/scan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-test" } });
    enqueueSbomScanMock.mockResolvedValue({
      jobId: "sbom-sj-123",
      scanJobId: "sj-123",
    });
    mockPrisma.repository.findFirst.mockResolvedValue({ id: "repo-xyz" });
  });

  it("returns 401 Unauthorized when session is missing", async () => {
    authMock.mockResolvedValue(null);

    const req = makePostRequest({ fileName: "package.json", content: "{}" });
    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(enqueueSbomScanMock).not.toHaveBeenCalled();
  });

  it("returns 400 Bad Request when body is invalid JSON", async () => {
    const req = makePostRequest("not-valid-json");
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(enqueueSbomScanMock).not.toHaveBeenCalled();
  });

  it("returns 400 Bad Request when fileName is missing", async () => {
    const req = makePostRequest({ content: "{}" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(enqueueSbomScanMock).not.toHaveBeenCalled();
  });

  it("returns 400 Bad Request when content is missing", async () => {
    const req = makePostRequest({ fileName: "package.json" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(enqueueSbomScanMock).not.toHaveBeenCalled();
  });

  it("returns 400 Bad Request when fileName is not a supported manifest", async () => {
    const req = makePostRequest({ fileName: "pom.xml", content: "<project></project>" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("supported manifest"),
    });
    expect(enqueueSbomScanMock).not.toHaveBeenCalled();
  });

  it("returns 400 Bad Request when fileName contains path traversal", async () => {
    const req = makePostRequest({
      fileName: "../../etc/passwd",
      content: "{}",
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("path traversal"),
    });
    expect(enqueueSbomScanMock).not.toHaveBeenCalled();
  });

  describe("bounded request ingestion (Finding 4)", () => {
    it("returns 413 when Content-Length header is oversized before reading body", async () => {
      const req = makePostRequest(
        { fileName: "package.json", content: "{}" },
        { "content-length": String(MAX_REQUEST_BYTES + 5000) },
      );
      const res = await POST(req);

      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({
        error: expect.stringContaining("exceeds maximum allowed size"),
      });
      expect(enqueueSbomScanMock).not.toHaveBeenCalled();
    });

    it("returns 413 when body without Content-Length is oversized", async () => {
      const hugeContent = "x".repeat(MAX_REQUEST_BYTES + 100);
      const req = makePostRequest({
        fileName: "package.json",
        content: hugeContent,
      });
      const res = await POST(req);

      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({
        error: expect.stringContaining("exceeds maximum allowed size"),
      });
      expect(enqueueSbomScanMock).not.toHaveBeenCalled();
    });

    it("returns 413 when manifest content itself exceeds 1MB", async () => {
      const oversized = "a".repeat(1024 * 1024 + 50);
      const req = makePostRequest({
        fileName: "package.json",
        content: oversized,
      });
      const res = await POST(req);

      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({
        error: expect.stringContaining("exceeds maximum allowed size"),
      });
      expect(enqueueSbomScanMock).not.toHaveBeenCalled();
    });
  });

  describe("repository ownership verification (Finding 5)", () => {
    it("succeeds with 202 when user owns the requested repository", async () => {
      mockPrisma.repository.findFirst.mockResolvedValue({ id: "repo-owned" });

      const req = makePostRequest({
        fileName: "package.json",
        content: JSON.stringify({ dependencies: { express: "4.18.2" } }),
        repositoryId: "repo-owned",
      });

      const res = await POST(req);

      expect(res.status).toBe(202);
      expect(mockPrisma.repository.findFirst).toHaveBeenCalledWith({
        where: { id: "repo-owned", userId: "user-test" },
        select: { id: true },
      });
      expect(enqueueSbomScanMock).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryId: "repo-owned",
          userId: "user-test",
        }),
      );
    });

    it("returns 404 when repository belongs to another user", async () => {
      // Not found for (id: repo-foreign, userId: user-test)
      mockPrisma.repository.findFirst.mockResolvedValue(null);

      const req = makePostRequest({
        fileName: "package.json",
        content: JSON.stringify({ dependencies: { express: "4.18.2" } }),
        repositoryId: "repo-foreign",
      });

      const res = await POST(req);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Repository not found" });
      expect(enqueueSbomScanMock).not.toHaveBeenCalled();
    });

    it("returns 404 when repository does not exist", async () => {
      mockPrisma.repository.findFirst.mockResolvedValue(null);

      const req = makePostRequest({
        fileName: "package.json",
        content: JSON.stringify({ dependencies: { express: "4.18.2" } }),
        repositoryId: "nonexistent-repo",
      });

      const res = await POST(req);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Repository not found" });
      expect(enqueueSbomScanMock).not.toHaveBeenCalled();
    });

    it("succeeds with 202 and leaves repositoryId undefined when omitted", async () => {
      const req = makePostRequest({
        fileName: "package.json",
        content: JSON.stringify({ dependencies: { express: "4.18.2" } }),
      });

      const res = await POST(req);

      expect(res.status).toBe(202);
      expect(mockPrisma.repository.findFirst).not.toHaveBeenCalled();
      expect(enqueueSbomScanMock).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryId: undefined,
          userId: "user-test",
        }),
      );
    });
  });
});
