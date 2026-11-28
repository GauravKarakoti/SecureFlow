import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getConnectableRepositories,
  checkRepositoryScanStatus,
  recordSimulatedScan,
} from "./connect-repo";

const {
  authMock,
  prismaRepoFindManyMock,
  prismaRepoFindFirstMock,
  prismaRepoCreateMock,
  prismaPrFindFirstMock,
  prismaPrCreateMock,
  prismaScanResultCreateMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  prismaRepoFindManyMock: vi.fn(),
  prismaRepoFindFirstMock: vi.fn(),
  prismaRepoCreateMock: vi.fn(),
  prismaPrFindFirstMock: vi.fn(),
  prismaPrCreateMock: vi.fn(),
  prismaScanResultCreateMock: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: authMock,
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    repository: {
      findMany: prismaRepoFindManyMock,
      findFirst: prismaRepoFindFirstMock,
      create: prismaRepoCreateMock,
    },
    pullRequest: {
      findFirst: prismaPrFindFirstMock,
      create: prismaPrCreateMock,
    },
    scanResult: {
      create: prismaScanResultCreateMock,
    },
  },
}));

describe("Connect Repository Server Actions (#2230)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getConnectableRepositories", () => {
    it("returns unauthorized error when user is not signed in", async () => {
      authMock.mockResolvedValue(null);
      const res = await getConnectableRepositories();
      expect(res.repositories).toEqual([]);
      expect(res.error).toBe("Unauthorized");
    });

    it("returns list of repositories with scan status", async () => {
      authMock.mockResolvedValue({ user: { id: "user-123" } });
      prismaRepoFindManyMock.mockResolvedValue([
        {
          id: "repo-1",
          fullName: "acme/api",
          owner: "acme",
          pullRequests: [
            {
              scans: [
                { createdAt: new Date("2026-11-28T10:00:00Z") },
              ],
            },
          ],
        },
        {
          id: "repo-2",
          fullName: "acme/web",
          owner: "acme",
          pullRequests: [],
        },
      ]);

      const res = await getConnectableRepositories();
      expect(res.repositories).toHaveLength(2);
      expect(res.repositories[0]).toEqual({
        id: "repo-1",
        fullName: "acme/api",
        owner: "acme",
        hasScans: true,
        lastScanAt: "2026-11-28T10:00:00.000Z",
      });
      expect(res.repositories[1]).toEqual({
        id: "repo-2",
        fullName: "acme/web",
        owner: "acme",
        hasScans: false,
        lastScanAt: null,
      });
    });
  });

  describe("checkRepositoryScanStatus", () => {
    it("returns hasScan: false when unauthenticated", async () => {
      authMock.mockResolvedValue(null);
      const res = await checkRepositoryScanStatus("acme/api");
      expect(res.hasScan).toBe(false);
    });

    it("returns hasScan: false when repository is not found or has no scans", async () => {
      authMock.mockResolvedValue({ user: { id: "user-123" } });
      prismaRepoFindFirstMock.mockResolvedValue({
        id: "repo-1",
        pullRequests: [],
      });

      const res = await checkRepositoryScanStatus("acme/api");
      expect(res.hasScan).toBe(false);
    });

    it("returns hasScan: true and latest scan details when scans exist", async () => {
      authMock.mockResolvedValue({ user: { id: "user-123" } });
      prismaRepoFindFirstMock.mockResolvedValue({
        id: "repo-1",
        fullName: "acme/api",
        pullRequests: [
          {
            prNumber: 42,
            scans: [
              {
                id: "scan-999",
                createdAt: new Date("2026-11-28T11:00:00Z"),
                riskScore: 92,
                policyDecision: "PASSED",
                headSha: "abcdef123456",
                findings: [{ id: "f-1", severity: "LOW" }],
              },
            ],
          },
        ],
      });

      const res = await checkRepositoryScanStatus("acme/api");
      expect(res.hasScan).toBe(true);
      expect(res.scan).toBeDefined();
      expect(res.scan?.id).toBe("scan-999");
      expect(res.scan?.riskScore).toBe(92);
      expect(res.scan?.policyDecision).toBe("PASSED");
      expect(res.scan?.findingsCount).toBe(1);
      expect(res.scan?.prNumber).toBe(42);
      expect(res.scan?.headSha).toBe("abcdef123456");
    });
  });

  describe("recordSimulatedScan", () => {
    it("returns unauthorized when session is missing", async () => {
      authMock.mockResolvedValue(null);
      const res = await recordSimulatedScan("acme/api");
      expect(res.success).toBe(false);
      expect(res.error).toBe("Unauthorized");
    });

    it("creates repository, pull request and scan when needed", async () => {
      authMock.mockResolvedValue({ user: { id: "user-123", name: "dev" } });
      prismaRepoFindFirstMock.mockResolvedValue(null);
      prismaRepoCreateMock.mockResolvedValue({
        id: "repo-new",
        fullName: "acme/api",
      });
      prismaPrFindFirstMock.mockResolvedValue(null);
      prismaPrCreateMock.mockResolvedValue({
        id: "pr-new",
      });
      prismaScanResultCreateMock.mockResolvedValue({
        id: "scan-sim-1",
      });

      const res = await recordSimulatedScan("acme/api");
      expect(res.success).toBe(true);
      expect(res.message).toContain("scan-sim-1");
      expect(prismaRepoCreateMock).toHaveBeenCalled();
      expect(prismaPrCreateMock).toHaveBeenCalled();
      expect(prismaScanResultCreateMock).toHaveBeenCalled();
    });
  });
});
