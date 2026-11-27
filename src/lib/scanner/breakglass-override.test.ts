import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  evaluateBreakglassOverride,
  hasOverrideLabel,
  isActorAuthorized,
  extractOverrideReason,
  recordOverrideAuditLog,
  DEFAULT_OVERRIDE_LABEL,
  DEFAULT_OVERRIDE_EXPIRY_MINUTES,
  type BreakglassConfig,
} from "./breakglass-override";
import prisma from "@/lib/prisma";

vi.mock("@/lib/prisma", () => ({
  default: {
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    },
  },
}));

describe("Break-Glass Override Label & Policy (#2094)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Label Detection", () => {
    it("detects default override label case-insensitively", () => {
      expect(hasOverrideLabel(["secureflow:override"], {})).toBe(true);
      expect(hasOverrideLabel(["SECUREFLOW:OVERRIDE"], {})).toBe(true);
      expect(hasOverrideLabel(["bug", "secureflow:override"], {})).toBe(true);
      expect(hasOverrideLabel(["feature", "urgent"], {})).toBe(false);
    });

    it("respects custom configured label", () => {
      const config: BreakglassConfig = { label: "security-override" };
      expect(hasOverrideLabel(["security-override"], config)).toBe(true);
      expect(hasOverrideLabel(["secureflow:override"], config)).toBe(false);
    });

    it("supports multiple configured labels", () => {
      const config: BreakglassConfig = { labels: ["break-glass", "sec-bypass"] };
      expect(hasOverrideLabel(["break-glass"], config)).toBe(true);
      expect(hasOverrideLabel(["sec-bypass"], config)).toBe(true);
      expect(hasOverrideLabel(["secureflow:override"], config)).toBe(true);
    });
  });

  describe("User Authorization", () => {
    it("authorizes user matching allowedUsers list", () => {
      const config: BreakglassConfig = { allowedUsers: ["alice", "bob"] };
      expect(isActorAuthorized("alice", "contributor", config)).toBe(true);
      expect(isActorAuthorized("BOB", undefined, config)).toBe(true);
      expect(isActorAuthorized("charlie", "contributor", config)).toBe(false);
    });

    it("authorizes user matching allowedRoles", () => {
      const config: BreakglassConfig = { allowedRoles: ["admin", "maintainer"] };
      expect(isActorAuthorized("user1", "admin", config)).toBe(true);
      expect(isActorAuthorized("user2", "maintainer", config)).toBe(true);
      expect(isActorAuthorized("user3", "contributor", config)).toBe(false);
      expect(isActorAuthorized("user4", "read", config)).toBe(false);
    });

    it("defaults to allowing admin and maintainer when roles not specified", () => {
      expect(isActorAuthorized("adminUser", "admin", {})).toBe(true);
      expect(isActorAuthorized("ownerUser", "owner", {})).toBe(true);
      expect(isActorAuthorized("maintainerUser", "maintainer", {})).toBe(true);
      expect(isActorAuthorized("randomUser", "contributor", {})).toBe(false);
    });
  });

  describe("Reason Extraction", () => {
    it("extracts override reason from directive comments", () => {
      const comments = [
        { author: "dev", body: "looks good", createdAt: new Date() },
        {
          author: "lead",
          body: "/override urgent hotfix for prod incident #123",
          createdAt: new Date(),
        },
      ];
      const extracted = extractOverrideReason(comments, "lead");
      expect(extracted).not.toBeNull();
      expect(extracted?.reason).toBe("urgent hotfix for prod incident #123");
      expect(extracted?.author).toBe("lead");
    });

    it("extracts reason from 'reason: ...' format", () => {
      const comments = [
        { author: "lead", body: "reason: false positive in legacy parser", createdAt: new Date() },
      ];
      const extracted = extractOverrideReason(comments, "lead");
      expect(extracted?.reason).toBe("false positive in legacy parser");
    });

    it("extracts plain comment from authorized actor", () => {
      const comments = [
        {
          author: "lead",
          body: "Approved emergency bypass due to customer blocking issue",
          createdAt: new Date(),
        },
      ];
      const extracted = extractOverrideReason(comments, "lead");
      expect(extracted?.reason).toContain("Approved emergency bypass");
    });

    it("returns null when no reason comment exists", () => {
      expect(extractOverrideReason([], "lead")).toBeNull();
    });
  });

  describe("Full Evaluation Logic", () => {
    it("passes override when label, authorized user, and reason are present", () => {
      const result = evaluateBreakglassOverride(
        {
          labels: ["secureflow:override"],
          comments: [
            {
              author: "alice",
              body: "/override false alarm verified with sec team",
              createdAt: new Date(),
            },
          ],
          sender: { login: "alice", role: "admin" },
          currentHeadSha: "commit-1",
          overrideHeadSha: "commit-1",
        },
        { allowedRoles: ["admin"] },
      );

      expect(result.isOverridden).toBe(true);
      expect(result.status).toBe("ACTIVE");
      expect(result.actor).toBe("alice");
      expect(result.reason).toBe("false alarm verified with sec team");
      expect(result.expiresAt).toBeDefined();
    });

    it("rejects override when user is unauthorized", () => {
      const result = evaluateBreakglassOverride(
        {
          labels: ["secureflow:override"],
          comments: [
            {
              author: "unauthorized_user",
              body: "/override need release now",
              createdAt: new Date(),
            },
          ],
          sender: { login: "unauthorized_user", role: "contributor" },
          currentHeadSha: "commit-1",
        },
        { allowedRoles: ["admin"], allowedUsers: ["alice"] },
      );

      expect(result.isOverridden).toBe(false);
      expect(result.status).toBe("UNAUTHORIZED");
      expect(result.notice).toContain("not authorized");
    });

    it("rejects override when reason comment is missing", () => {
      const result = evaluateBreakglassOverride(
        {
          labels: ["secureflow:override"],
          comments: [],
          sender: { login: "alice", role: "admin" },
          currentHeadSha: "commit-1",
        },
        { allowedRoles: ["admin"], requireReason: true },
      );

      expect(result.isOverridden).toBe(false);
      expect(result.status).toBe("MISSING_REASON");
      expect(result.notice).toContain("no override reason comment was provided");
    });

    it("revokes override when new commits are pushed after override", () => {
      const result = evaluateBreakglassOverride(
        {
          labels: ["secureflow:override"],
          comments: [{ author: "alice", body: "/override emergency fix", createdAt: new Date() }],
          sender: { login: "alice", role: "admin" },
          currentHeadSha: "commit-2",
          overrideHeadSha: "commit-1",
        },
        { allowedRoles: ["admin"], revokeOnNewCommits: true },
      );

      expect(result.isOverridden).toBe(false);
      expect(result.status).toBe("REVOKED_NEW_COMMITS");
      expect(result.notice).toContain("revoked because new commits were pushed");
    });

    it("revokes override when time has expired", () => {
      const pastTime = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago
      const result = evaluateBreakglassOverride(
        {
          labels: ["secureflow:override"],
          comments: [{ author: "alice", body: "/override quick fix", createdAt: pastTime }],
          sender: { login: "alice", role: "admin" },
          currentHeadSha: "commit-1",
          overrideHeadSha: "commit-1",
          overrideCreatedAt: pastTime,
        },
        { allowedRoles: ["admin"], expiresInMinutes: 120 }, // 2 hours
      );

      expect(result.isOverridden).toBe(false);
      expect(result.status).toBe("EXPIRED");
      expect(result.notice).toContain("expired");
    });
  });

  describe("Audit Logging", () => {
    it("records override event to audit log", async () => {
      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
      await recordOverrideAuditLog({
        repositoryFullName: "acme/api",
        prNumber: 42,
        actor: "sec-officer",
        reason: "False positive approved by security",
        headSha: "abc1234",
        expiresAt,
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          action: "BREAKGLASS_OVERRIDE",
          resource: "acme/api#42",
          decision: "OVERRIDDEN",
          metadata: expect.objectContaining({
            actor: "sec-officer",
            reason: "False positive approved by security",
            headSha: "abc1234",
          }),
        },
      });
    });
  });
});
