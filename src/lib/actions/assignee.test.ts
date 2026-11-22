import { describe, it, expect, vi, beforeEach } from "vitest";

let mockSession: { user: { id: string } } | null = { user: { id: "user-owner" } };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => mockSession),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const mockRepoFindUnique = vi.hoisted(() => vi.fn());
const mockUserFindUnique = vi.hoisted(() => vi.fn());
const mockUserFindMany = vi.hoisted(() => vi.fn());
const mockTriageUpsert = vi.hoisted(() => vi.fn());
const mockTriageFindMany = vi.hoisted(() => vi.fn());
const mockTriageUpdate = vi.hoisted(() => vi.fn());
const mockTriageUpdateMany = vi.hoisted(() => vi.fn());
const mockAuditCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  default: {
    repository: { findUnique: mockRepoFindUnique },
    user: { findUnique: mockUserFindUnique, findMany: mockUserFindMany },
    findingTriage: {
      upsert: mockTriageUpsert,
      findMany: mockTriageFindMany,
      update: mockTriageUpdate,
      updateMany: mockTriageUpdateMany,
    },
    auditLog: { create: mockAuditCreate },
  },
}));

import {
  checkUserRepoAccess,
  getAssignableUsers,
  assignFinding,
  unassignInaccessibleFindings,
  onUserAccessLoss,
} from "./assignee";

describe("assignee actions (#1921)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = { user: { id: "user-owner" } };

    mockRepoFindUnique.mockResolvedValue({
      id: "repo-1",
      userId: "user-owner",
      isActive: true,
      user: {
        id: "user-owner",
        name: "Owner Alice",
        email: "alice@example.com",
        codename: "alice-sec",
        image: null,
      },
    });

    mockUserFindUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === "user-owner") {
        return {
          id: "user-owner",
          name: "Owner Alice",
          email: "alice@example.com",
          codename: "alice-sec",
          roles: [{ role: { name: "USER" } }],
        };
      }
      if (where.id === "user-admin") {
        return {
          id: "user-admin",
          name: "Admin Bob",
          email: "bob@example.com",
          codename: "bob-admin",
          roles: [{ role: { name: "ADMIN" } }],
        };
      }
      if (where.id === "user-other") {
        return {
          id: "user-other",
          name: "Stranger Charlie",
          email: "charlie@example.com",
          codename: "charlie-stranger",
          roles: [{ role: { name: "USER" } }],
        };
      }
      return null;
    });

    mockUserFindMany.mockResolvedValue([
      {
        id: "user-admin",
        name: "Admin Bob",
        email: "bob@example.com",
        codename: "bob-admin",
        image: null,
      },
    ]);

    mockTriageUpsert.mockResolvedValue({ id: "triage-1" });
    mockAuditCreate.mockResolvedValue({});
  });

  describe("checkUserRepoAccess", () => {
    it("returns true for repository owner when repo is active", async () => {
      const hasAccess = await checkUserRepoAccess("user-owner", "repo-1");
      expect(hasAccess).toBe(true);
    });

    it("returns false when repository is inactive", async () => {
      mockRepoFindUnique.mockResolvedValueOnce({
        id: "repo-1",
        userId: "user-owner",
        isActive: false,
      });

      const hasAccess = await checkUserRepoAccess("user-owner", "repo-1");
      expect(hasAccess).toBe(false);
    });

    it("returns true for system ADMIN even if not the repo owner", async () => {
      const hasAccess = await checkUserRepoAccess("user-admin", "repo-1");
      expect(hasAccess).toBe(true);
    });

    it("returns false for non-owner, non-admin user", async () => {
      const hasAccess = await checkUserRepoAccess("user-other", "repo-1");
      expect(hasAccess).toBe(false);
    });
  });

  describe("getAssignableUsers", () => {
    it("returns list of users with access to the repository", async () => {
      const users = await getAssignableUsers("repo-1");
      expect(users).toHaveLength(2);
      expect(users.map((u) => u.id)).toContain("user-owner");
      expect(users.map((u) => u.id)).toContain("user-admin");
    });

    it("throws error if caller does not have access to repository", async () => {
      mockSession = { user: { id: "user-other" } };
      await expect(getAssignableUsers("repo-1")).rejects.toThrow(
        "Repository not found or access denied",
      );
    });
  });

  describe("assignFinding permissions & assignment", () => {
    it("allows assigning finding to candidate user with repository access", async () => {
      const result = await assignFinding({
        repositoryId: "repo-1",
        fingerprint: "fp-test-1",
        assigneeId: "user-admin",
      });

      expect(result.ok).toBe(true);
      expect(result.assigneeId).toBe("user-admin");

      expect(mockTriageUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            repositoryId_fingerprint: {
              repositoryId: "repo-1",
              fingerprint: "fp-test-1",
            },
          },
          update: { assigneeId: "user-admin" },
        }),
      );

      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "FINDING_ASSIGN",
            decision: "ASSIGNED",
            metadata: expect.objectContaining({
              assigneeId: "user-admin",
              fingerprint: "fp-test-1",
            }),
          }),
        }),
      );
    });

    it("rejects assignment if candidate user does not have repository access", async () => {
      const result = await assignFinding({
        repositoryId: "repo-1",
        fingerprint: "fp-test-1",
        assigneeId: "user-other",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/does not have access/i);
      expect(mockTriageUpsert).not.toHaveBeenCalled();
    });

    it("allows unassigning finding and writes audit log", async () => {
      const result = await assignFinding({
        repositoryId: "repo-1",
        fingerprint: "fp-test-1",
        assigneeId: null,
      });

      expect(result.ok).toBe(true);
      expect(result.assigneeId).toBeNull();

      expect(mockTriageUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: { assigneeId: null },
        }),
      );

      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "FINDING_ASSIGN",
            decision: "UNASSIGNED",
          }),
        }),
      );
    });

    it("rejects callers without repository access", async () => {
      mockSession = { user: { id: "user-other" } };

      const result = await assignFinding({
        repositoryId: "repo-1",
        fingerprint: "fp-test-1",
        assigneeId: "user-owner",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/do not have access/i);
    });
  });

  describe("access-loss case (#1921)", () => {
    it("automatically unassigns findings when assignee loses repository access", async () => {
      mockTriageFindMany.mockResolvedValueOnce([
        {
          id: "triage-1",
          repositoryId: "repo-1",
          fingerprint: "fp-1",
          assigneeId: "user-other", // user-other has no access
        },
        {
          id: "triage-2",
          repositoryId: "repo-1",
          fingerprint: "fp-2",
          assigneeId: "user-owner", // user-owner still has access
        },
      ]);

      const result = await unassignInaccessibleFindings("repo-1");

      expect(result.unassignedCount).toBe(1);
      expect(mockTriageUpdate).toHaveBeenCalledWith({
        where: { id: "triage-1" },
        data: { assigneeId: null },
      });
      expect(mockTriageUpdate).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "triage-2" } }),
      );

      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "FINDING_UNASSIGN_ACCESS_LOSS",
            decision: "UNASSIGNED",
            metadata: expect.objectContaining({
              reason: "ACCESS_LOSS",
              previousAssigneeId: "user-other",
            }),
          }),
        }),
      );
    });

    it("onUserAccessLoss unassigns all findings for that user in the repository", async () => {
      mockTriageFindMany.mockResolvedValueOnce([
        { id: "triage-1", repositoryId: "repo-1", fingerprint: "fp-1", assigneeId: "user-demoted" },
        { id: "triage-3", repositoryId: "repo-1", fingerprint: "fp-3", assigneeId: "user-demoted" },
      ]);

      const result = await onUserAccessLoss("user-demoted", "repo-1");

      expect(result.unassignedCount).toBe(2);
      expect(mockTriageUpdateMany).toHaveBeenCalledWith({
        where: {
          repositoryId: "repo-1",
          assigneeId: "user-demoted",
        },
        data: { assigneeId: null },
      });
      expect(mockAuditCreate).toHaveBeenCalledTimes(2);
    });
  });
});
