import { describe, it, expect, vi, beforeEach } from "vitest";

let session: { user: { id: string } } | null = { user: { id: "user-1" } };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => session),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const mockFindUniqueTemplate = vi.hoisted(() => vi.fn());
const mockUpdateTemplate = vi.hoisted(() => vi.fn());
const mockFindUniqueVersion = vi.hoisted(() => vi.fn());
const mockFindFirstVersion = vi.hoisted(() => vi.fn());
const mockFindManyVersions = vi.hoisted(() => vi.fn());
const mockCreateVersion = vi.hoisted(() => vi.fn());
const mockFindFirstToggle = vi.hoisted(() => vi.fn());
const mockAuditCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => {
  const db: any = {
    $transaction: vi.fn(async (cb: any) => cb(db)),
    policyTemplate: {
      findUnique: mockFindUniqueTemplate,
      update: mockUpdateTemplate,
    },
    policyVersion: {
      findUnique: mockFindUniqueVersion,
      findFirst: mockFindFirstVersion,
      findMany: mockFindManyVersions,
      create: mockCreateVersion,
    },
    userPolicyToggle: {
      findFirst: mockFindFirstToggle,
    },
    auditLog: {
      create: mockAuditCreate,
    },
  };
  return { default: db };
});

vi.mock("@/lib/policies/policy-cache", () => ({
  invalidatePolicyCache: vi.fn(async () => {}),
}));

import { editPolicy, rollbackPolicy, getPolicyVersions } from "./actions";

describe("Policy Versioning, History, and Rollback", () => {
  const template = {
    id: "tpl-1",
    name: "Enforce Parameterized Queries",
    description: "Initial description",
    severity: "HIGH",
    action: "REVIEW REQUIRED",
    rules: ["db/*"],
    isDefault: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    session = { user: { id: "user-1" } };
    mockFindUniqueTemplate.mockResolvedValue(template);
    mockFindFirstVersion.mockResolvedValue(null);
    mockCreateVersion.mockImplementation(async ({ data }: any) => ({ id: "ver-new", ...data }));
    mockUpdateTemplate.mockImplementation(async ({ data }: any) => ({ ...template, ...data }));
    mockAuditCreate.mockResolvedValue({});
    mockFindFirstToggle.mockResolvedValue({
      id: "toggle-1",
      userId: "user-1",
      policyTemplateId: "tpl-1",
      isActive: true,
    });
  });

  describe("editPolicy", () => {
    it("updates policy template and creates an immutable version entry", async () => {
      const result = await editPolicy({
        templateId: "tpl-1",
        description: "Updated description text",
        severity: "CRITICAL",
      });

      expect(result.ok).toBe(true);
      expect(result.versionNumber).toBe(1);

      expect(mockUpdateTemplate).toHaveBeenCalledWith({
        where: { id: "tpl-1" },
        data: {
          description: "Updated description text",
          severity: "CRITICAL",
        },
      });

      expect(mockCreateVersion).toHaveBeenCalledWith({
        data: {
          policyTemplateId: "tpl-1",
          userId: "user-1",
          versionNumber: 1,
          name: template.name,
          description: "Updated description text",
          severity: "CRITICAL",
          action: "REVIEW REQUIRED",
          rules: template.rules,
        },
      });

      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "user-1",
            action: "POLICY_EDIT",
            resource: "policy:Enforce Parameterized Queries",
            decision: "UPDATED",
          }),
        }),
      );
    });

    it("increments version number on subsequent edits", async () => {
      mockFindFirstVersion.mockResolvedValue({ versionNumber: 3 });

      const result = await editPolicy({
        templateId: "tpl-1",
        description: "Fourth version",
        severity: "LOW",
      });

      expect(result.ok).toBe(true);
      expect(result.versionNumber).toBe(4);
      expect(mockCreateVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ versionNumber: 4 }),
        }),
      );
    });

    it("fails when unauthenticated", async () => {
      session = null;
      const result = await editPolicy({
        templateId: "tpl-1",
        description: "Test",
        severity: "HIGH",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("session has expired");
    });
  });

  describe("getPolicyVersions", () => {
    it("returns version history for an authorized user", async () => {
      const mockVersions = [
        {
          id: "ver-2",
          policyTemplateId: "tpl-1",
          versionNumber: 2,
          name: template.name,
          description: "Version 2 description",
          severity: "CRITICAL",
          action: "BLOCK",
          rules: [],
          createdAt: new Date("2026-11-13T12:00:00.000Z"),
          editor: { id: "user-1", name: "Alice", email: "alice@example.com" },
        },
        {
          id: "ver-1",
          policyTemplateId: "tpl-1",
          versionNumber: 1,
          name: template.name,
          description: "Version 1 description",
          severity: "HIGH",
          action: "REVIEW REQUIRED",
          rules: [],
          createdAt: new Date("2026-11-13T10:00:00.000Z"),
          editor: { id: "user-1", name: "Alice", email: "alice@example.com" },
        },
      ];
      mockFindManyVersions.mockResolvedValue(mockVersions);

      const history = await getPolicyVersions("tpl-1");
      expect(history).toHaveLength(2);
      expect(history[0].versionNumber).toBe(2);
      expect(history[1].versionNumber).toBe(1);
    });

    it("blocks unauthorized users who have no access to custom policy", async () => {
      mockFindUniqueTemplate.mockResolvedValue({ ...template, isDefault: false });
      mockFindFirstToggle.mockResolvedValue(null);
      mockFindFirstVersion.mockResolvedValue(null);

      await expect(getPolicyVersions("tpl-1")).rejects.toThrow("Unauthorized");
    });
  });

  describe("rollbackPolicy", () => {
    it("restores older version content by adding a new version row and logging audit entry", async () => {
      const historicalVersion = {
        id: "ver-1",
        policyTemplateId: "tpl-1",
        versionNumber: 1,
        name: template.name,
        description: "Original safe description",
        severity: "HIGH",
        action: "REVIEW REQUIRED",
        rules: ["db/*"],
      };
      mockFindUniqueVersion.mockResolvedValue(historicalVersion);
      mockFindFirstVersion.mockResolvedValue({ versionNumber: 4 }); // Currently at version 4

      const result = await rollbackPolicy({
        templateId: "tpl-1",
        versionId: "ver-1",
      });

      expect(result.ok).toBe(true);
      // Creates new version 5, not overwriting or deleting versions 1-4!
      expect(result.versionNumber).toBe(5);

      // Template is updated with historical content
      expect(mockUpdateTemplate).toHaveBeenCalledWith({
        where: { id: "tpl-1" },
        data: {
          description: "Original safe description",
          severity: "HIGH",
          action: "REVIEW REQUIRED",
          rules: ["db/*"],
        },
      });

      // New version row created
      expect(mockCreateVersion).toHaveBeenCalledWith({
        data: {
          policyTemplateId: "tpl-1",
          userId: "user-1",
          versionNumber: 5,
          name: template.name,
          description: "Original safe description",
          severity: "HIGH",
          action: "REVIEW REQUIRED",
          rules: ["db/*"],
        },
      });

      // Audit log recorded
      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "user-1",
            action: "POLICY_ROLLBACK",
            resource: "policy:Enforce Parameterized Queries",
            decision: "RESTORED",
            metadata: expect.objectContaining({
              restoredFromVersionNumber: 1,
              newVersionNumber: 5,
            }),
          }),
        }),
      );
    });

    it("blocks unauthorized users from rolling back policies they cannot access", async () => {
      mockFindUniqueTemplate.mockResolvedValue({ ...template, isDefault: false });
      mockFindFirstToggle.mockResolvedValue(null);
      mockFindUniqueVersion.mockResolvedValue({
        id: "ver-1",
        policyTemplateId: "tpl-1",
        userId: "other-user",
      });
      mockFindFirstVersion.mockResolvedValue(null);

      const result = await rollbackPolicy({
        templateId: "tpl-1",
        versionId: "ver-1",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("do not have permission");
    });
  });
});
