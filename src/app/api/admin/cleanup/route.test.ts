import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST, isAuthorizedCleanupRequest } from "./route";
import * as cleanupEngine from "@/lib/retention/cleanup";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  default: {},
}));

vi.mock("@/lib/retention/cleanup", async () => {
  const actual = await vi.importActual<typeof cleanupEngine>("@/lib/retention/cleanup");
  return {
    ...actual,
    cleanupDataRetention: vi.fn(async (_db, options) => ({
      success: true,
      enabled: options?.days !== undefined || Boolean(process.env.DATA_RETENTION_DAYS),
      dryRun: Boolean(options?.dryRun),
      retentionDays: options?.days ?? 30,
      cutoff: "2026-07-17T12:00:00.000Z",
      findingsDeleted: options?.dryRun ? 0 : 5,
      auditLogsDeleted: options?.dryRun ? 0 : 3,
      findingsEligible: options?.dryRun ? 5 : undefined,
      auditLogsEligible: options?.dryRun ? 3 : undefined,
      totalAffected: 8,
      message: "Cleanup complete",
    })),
  };
});

describe("Admin Data Retention Cleanup Route (/api/admin/cleanup)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLEANUP_SECRET = "super-secret-cleanup-token";
    process.env.CRON_SECRET = "cron-job-token";
    process.env.AUTH_SECRET = "auth-secret-token";
  });

  describe("Authorization & Secret Verification (isAuthorizedCleanupRequest)", () => {
    it("accepts requests with valid Bearer token in Authorization header", () => {
      const req = new NextRequest("http://localhost:9002/api/admin/cleanup", {
        headers: { authorization: "Bearer super-secret-cleanup-token" },
      });
      expect(isAuthorizedCleanupRequest(req, null)).toBe(true);
    });

    it("accepts requests with valid CRON_SECRET Bearer token", () => {
      const req = new NextRequest("http://localhost:9002/api/admin/cleanup", {
        headers: { authorization: "Bearer cron-job-token" },
      });
      expect(isAuthorizedCleanupRequest(req, null)).toBe(true);
    });

    it("accepts requests with valid x-cleanup-secret header", () => {
      const req = new NextRequest("http://localhost:9002/api/admin/cleanup", {
        headers: { "x-cleanup-secret": "super-secret-cleanup-token" },
      });
      expect(isAuthorizedCleanupRequest(req, null)).toBe(true);
    });

    it("accepts requests with valid x-cron-secret header", () => {
      const req = new NextRequest("http://localhost:9002/api/admin/cleanup", {
        headers: { "x-cron-secret": "cron-job-token" },
      });
      expect(isAuthorizedCleanupRequest(req, null)).toBe(true);
    });

    it("accepts requests from users with ADMIN role session", () => {
      const req = new NextRequest("http://localhost:9002/api/admin/cleanup");
      expect(isAuthorizedCleanupRequest(req, { roles: ["ADMIN"] })).toBe(true);
    });

    it("rejects unauthorized requests without secret or admin session", () => {
      const req = new NextRequest("http://localhost:9002/api/admin/cleanup");
      expect(isAuthorizedCleanupRequest(req, null)).toBe(false);
      expect(isAuthorizedCleanupRequest(req, { roles: ["USER"] })).toBe(false);
    });

    it("rejects requests with incorrect secret tokens", () => {
      const req = new NextRequest("http://localhost:9002/api/admin/cleanup", {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(isAuthorizedCleanupRequest(req, null)).toBe(false);
    });
  });

  describe("GET Handler (Dry-run preview)", () => {
    it("rejects unauthorized calls with 401", async () => {
      const { auth } = await import("@/auth");
      vi.mocked(auth).mockResolvedValueOnce(null as any);

      const req = new NextRequest("http://localhost:9002/api/admin/cleanup");
      const res = await GET(req);
      expect(res.status).toBe(401);
    });

    it("executes as dry-run when authorized via secret token", async () => {
      const { auth } = await import("@/auth");
      vi.mocked(auth).mockResolvedValueOnce(null as any);

      const req = new NextRequest("http://localhost:9002/api/admin/cleanup?days=45", {
        headers: { authorization: "Bearer super-secret-cleanup-token" },
      });

      const res = await GET(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.dryRun).toBe(true);
      expect(cleanupEngine.cleanupDataRetention).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ dryRun: true, days: 45 }),
      );
    });
  });

  describe("POST Handler (Cleanup execution)", () => {
    it("rejects unauthorized calls with 401", async () => {
      const { auth } = await import("@/auth");
      vi.mocked(auth).mockResolvedValueOnce(null as any);

      const req = new NextRequest("http://localhost:9002/api/admin/cleanup", {
        method: "POST",
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
    });

    it("supports applied cleanup when dryRun is false", async () => {
      const { auth } = await import("@/auth");
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: "admin-1", roles: ["ADMIN"] },
      } as any);

      const req = new NextRequest("http://localhost:9002/api/admin/cleanup", {
        method: "POST",
        body: JSON.stringify({ dryRun: false, days: 60, batchSize: 200 }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(cleanupEngine.cleanupDataRetention).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ dryRun: false, days: 60, batchSize: 200 }),
      );
    });

    it("honors dryRun flag in POST body", async () => {
      const req = new NextRequest("http://localhost:9002/api/admin/cleanup", {
        method: "POST",
        headers: { authorization: "Bearer super-secret-cleanup-token" },
        body: JSON.stringify({ dryRun: true }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.dryRun).toBe(true);
      expect(cleanupEngine.cleanupDataRetention).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ dryRun: true }),
      );
    });

    it("rejects invalid days parameter with 400", async () => {
      const req = new NextRequest("http://localhost:9002/api/admin/cleanup", {
        method: "POST",
        headers: { authorization: "Bearer super-secret-cleanup-token" },
        body: JSON.stringify({ days: -10 }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });
});
