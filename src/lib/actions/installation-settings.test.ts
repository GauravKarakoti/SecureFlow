import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getInstallationSettings,
  updateInstallationSettings,
  getRepositoryEffectiveSettings,
} from "./installation-settings";

const { mockAuth, mockPrisma, mockAssertCan, mockRevalidatePath } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrisma: {
    installationSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
  mockAssertCan: vi.fn(),
  mockRevalidatePath: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/prisma", () => ({
  default: mockPrisma,
}));

vi.mock("@/lib/auth/permissions", () => ({
  assertCan: mockAssertCan,
}));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

describe("Installation Settings Server Actions (#2010)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getInstallationSettings", () => {
    it("returns empty/null baseline DTO when no record exists in database", async () => {
      mockPrisma.installationSettings.findUnique.mockResolvedValue(null);

      const settings = await getInstallationSettings("default");

      expect(settings).toEqual({
        installationId: "default",
        gateBlockOn: null,
        gateReviewOn: null,
        minCommentConfidence: null,
        includeDefaults: null,
        skipDrafts: null,
        skipAuthors: [],
        lockedSettings: [],
      });
    });

    it("returns database record when found", async () => {
      mockPrisma.installationSettings.findUnique.mockResolvedValue({
        installationId: "default",
        gateBlockOn: "HIGH",
        gateReviewOn: "LOW",
        minCommentConfidence: "MEDIUM",
        includeDefaults: false,
        skipDrafts: true,
        skipAuthors: ["renovate[bot]"],
        lockedSettings: ["gateBlockOn"],
      });

      const settings = await getInstallationSettings("default");

      expect(settings.gateBlockOn).toBe("HIGH");
      expect(settings.lockedSettings).toEqual(["gateBlockOn"]);
      expect(settings.skipAuthors).toEqual(["renovate[bot]"]);
    });

    it("falls back to 'default' when specific installationId record is not found", async () => {
      mockPrisma.installationSettings.findUnique
        .mockResolvedValueOnce(null) // for 'org-123'
        .mockResolvedValueOnce({
          installationId: "default",
          gateBlockOn: "CRITICAL",
          gateReviewOn: "HIGH",
          minCommentConfidence: "HIGH",
          includeDefaults: true,
          skipDrafts: false,
          skipAuthors: [],
          lockedSettings: ["gateBlockOn"],
        }); // fallback for 'default'

      const settings = await getInstallationSettings("org-123");

      expect(settings.gateBlockOn).toBe("CRITICAL");
      expect(mockPrisma.installationSettings.findUnique).toHaveBeenCalledTimes(2);
    });
  });

  describe("updateInstallationSettings", () => {
    it("throws unauthorized when user is not authenticated", async () => {
      mockAuth.mockResolvedValue(null);

      await expect(
        updateInstallationSettings("default", { gateBlockOn: "CRITICAL" }),
      ).rejects.toThrow("Unauthorized: Admin role required");
    });

    it("throws unauthorized when user does not have ADMIN role", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "user-1", roles: ["DEVELOPER"] },
      });

      await expect(
        updateInstallationSettings("default", { gateBlockOn: "CRITICAL" }),
      ).rejects.toThrow("Unauthorized: Admin role required");
    });

    it("successfully updates settings and creates audit log", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin-1", roles: ["ADMIN"] },
      });

      const previousRecord = {
        installationId: "default",
        gateBlockOn: "HIGH",
        gateReviewOn: "LOW",
        minCommentConfidence: "MEDIUM",
        includeDefaults: true,
        skipDrafts: false,
        skipAuthors: [],
        lockedSettings: [],
      };

      const updatedRecord = {
        installationId: "default",
        gateBlockOn: "CRITICAL",
        gateReviewOn: "MEDIUM",
        minCommentConfidence: "HIGH",
        includeDefaults: true,
        skipDrafts: false,
        skipAuthors: ["bot"],
        lockedSettings: ["gateBlockOn"],
      };

      mockPrisma.installationSettings.findUnique.mockResolvedValue(previousRecord);
      mockPrisma.installationSettings.upsert.mockResolvedValue(updatedRecord);
      mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });

      const res = await updateInstallationSettings("default", {
        gateBlockOn: "CRITICAL",
        gateReviewOn: "MEDIUM",
        minCommentConfidence: "HIGH",
        skipAuthors: ["bot"],
        lockedSettings: ["gateBlockOn", "invalidKey"],
      });

      expect(res.ok).toBe(true);
      expect(res.settings?.gateBlockOn).toBe("CRITICAL");
      expect(res.settings?.lockedSettings).toEqual(["gateBlockOn"]); // filters invalidKey

      // Audit log verification
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "admin-1",
            action: "INSTALLATION_SETTINGS_UPDATE",
            resource: "installation:default",
            metadata: expect.objectContaining({
              installationId: "default",
              previous: expect.any(Object),
              updated: expect.any(Object),
            }),
          }),
        }),
      );

      // Revalidation verification
      expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/settings");
      expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/settings");
    });
  });

  describe("getRepositoryEffectiveSettings", () => {
    it("resolves effective settings for a repository against installation settings", async () => {
      mockPrisma.installationSettings.findUnique.mockResolvedValue({
        installationId: "default",
        gateBlockOn: "HIGH",
        gateReviewOn: "MEDIUM",
        minCommentConfidence: "MEDIUM",
        includeDefaults: true,
        skipDrafts: false,
        skipAuthors: [],
        lockedSettings: ["gateBlockOn"],
      });

      const repoConfig = {
        blockOn: "LOW", // Will be blocked by locked gateBlockOn
        reviewOn: "LOW",
      };

      const resolved = await getRepositoryEffectiveSettings(repoConfig, "default");

      expect(resolved.gateBlockOn.value).toBe("HIGH");
      expect(resolved.gateBlockOn.isLocked).toBe(true);
      expect(resolved.gateBlockOn.source).toBe("installation");

      expect(resolved.gateReviewOn.value).toBe("LOW");
      expect(resolved.gateReviewOn.source).toBe("repository");
    });
  });
});
