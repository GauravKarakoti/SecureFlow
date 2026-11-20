import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getSavedViews,
  createSavedView,
  deleteSavedView,
  sanitizeViewFilters,
} from "./saved-views";
import prisma from "@/lib/prisma";
import { auth } from "@/auth";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    savedView: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

describe("Saved Views Server Actions (#1786)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("sanitizeViewFilters", () => {
    it("preserves whitelisted filter properties", async () => {
      const input = {
        severity: ["CRITICAL", "HIGH"],
        type: ["SECRET"],
        status: ["OPEN"],
        repositoryId: "repo-123",
        search: "apiKey",
        from: "2026-11-01",
        to: "2026-11-15",
        sort: "severity",
      };

      const result = await sanitizeViewFilters(input);
      expect(result).toEqual(input);
    });

    it("strips sensitive fields like tokens and code snippets", async () => {
      const input = {
        severity: ["HIGH"],
        token: "ghp_secretToken123456789",
        apiKey: "sk-live-xyz",
        snippet: "const password = 'admin'",
        authorization: "Bearer secret",
      };

      const result = await sanitizeViewFilters(input);
      expect(result).toEqual({ severity: ["HIGH"] });
      expect((result as any).token).toBeUndefined();
      expect((result as any).apiKey).toBeUndefined();
      expect((result as any).snippet).toBeUndefined();
      expect((result as any).authorization).toBeUndefined();
    });

    it("ignores malformed dates", async () => {
      const input = {
        from: "not-a-date",
        to: "2026-11-01",
      };

      const result = await sanitizeViewFilters(input);
      expect(result.from).toBeUndefined();
      expect(result.to).toBe("2026-11-01");
    });
  });

  describe("getSavedViews", () => {
    it("throws Unauthorized when session is missing", async () => {
      vi.mocked(auth).mockResolvedValue(null as any);
      await expect(getSavedViews()).rejects.toThrow("Unauthorized");
    });

    it("returns views scoped strictly to the current user", async () => {
      vi.mocked(auth).mockResolvedValue({ user: { id: "user-alpha" } } as any);
      const mockViews = [
        {
          id: "view-1",
          userId: "user-alpha",
          name: "Open Criticals",
          filters: { severity: ["CRITICAL"], status: ["OPEN"] },
          createdAt: new Date("2026-11-10"),
          updatedAt: new Date("2026-11-10"),
        },
      ];
      vi.mocked(prisma.savedView.findMany).mockResolvedValue(mockViews as any);

      const views = await getSavedViews();

      expect(prisma.savedView.findMany).toHaveBeenCalledWith({
        where: { userId: "user-alpha" },
        orderBy: { createdAt: "desc" },
      });
      expect(views).toHaveLength(1);
      expect(views[0].name).toBe("Open Criticals");
      expect(views[0].userId).toBe("user-alpha");
    });
  });

  describe("createSavedView", () => {
    it("throws Unauthorized when session is missing", async () => {
      vi.mocked(auth).mockResolvedValue(null as any);
      await expect(
        createSavedView({ name: "My View", filters: { severity: ["HIGH"] } }),
      ).rejects.toThrow("Unauthorized");
    });

    it("throws error for empty view name", async () => {
      vi.mocked(auth).mockResolvedValue({ user: { id: "user-alpha" } } as any);
      await expect(
        createSavedView({ name: "   ", filters: { severity: ["HIGH"] } }),
      ).rejects.toThrow("View name is required");
    });

    it("throws error for excessively long view name", async () => {
      vi.mocked(auth).mockResolvedValue({ user: { id: "user-alpha" } } as any);
      await expect(createSavedView({ name: "a".repeat(81), filters: {} })).rejects.toThrow(
        "View name cannot exceed 80 characters",
      );
    });

    it("saves a view for the authenticated user and sanitizes filters", async () => {
      vi.mocked(auth).mockResolvedValue({ user: { id: "user-alpha" } } as any);
      const mockSaved = {
        id: "view-100",
        userId: "user-alpha",
        name: "Backend Secrets",
        filters: { type: ["SECRET"], repositoryId: "repo-9" },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      vi.mocked(prisma.savedView.upsert).mockResolvedValue(mockSaved as any);

      const result = await createSavedView({
        name: "Backend Secrets",
        filters: {
          type: ["SECRET"],
          repositoryId: "repo-9",
          secretToken: "must-be-stripped",
        } as any,
      });

      expect(prisma.savedView.upsert).toHaveBeenCalledWith({
        where: {
          userId_name: {
            userId: "user-alpha",
            name: "Backend Secrets",
          },
        },
        create: {
          userId: "user-alpha",
          name: "Backend Secrets",
          filters: { type: ["SECRET"], repositoryId: "repo-9" },
        },
        update: {
          filters: { type: ["SECRET"], repositoryId: "repo-9" },
        },
      });
      expect(result.name).toBe("Backend Secrets");
    });
  });

  describe("deleteSavedView permissions", () => {
    it("throws Unauthorized when session is missing", async () => {
      vi.mocked(auth).mockResolvedValue(null as any);
      await expect(deleteSavedView("view-1")).rejects.toThrow("Unauthorized");
    });

    it("throws not found when view does not exist", async () => {
      vi.mocked(auth).mockResolvedValue({ user: { id: "user-alpha" } } as any);
      vi.mocked(prisma.savedView.findUnique).mockResolvedValue(null);

      await expect(deleteSavedView("non-existent")).rejects.toThrow("Saved view not found");
    });

    it("allows the owner to delete their saved view", async () => {
      vi.mocked(auth).mockResolvedValue({ user: { id: "user-alpha" } } as any);
      vi.mocked(prisma.savedView.findUnique).mockResolvedValue({
        id: "view-1",
        userId: "user-alpha",
        name: "My View",
      } as any);
      vi.mocked(prisma.savedView.delete).mockResolvedValue({ id: "view-1" } as any);

      const res = await deleteSavedView("view-1");
      expect(res.success).toBe(true);
      expect(prisma.savedView.delete).toHaveBeenCalledWith({
        where: { id: "view-1" },
      });
    });

    it("prevents User Beta from deleting User Alpha's saved view (Forbidden)", async () => {
      vi.mocked(auth).mockResolvedValue({ user: { id: "user-beta" } } as any);
      vi.mocked(prisma.savedView.findUnique).mockResolvedValue({
        id: "view-1",
        userId: "user-alpha", // owned by user-alpha, NOT user-beta
        name: "Alpha's Secret View",
      } as any);

      await expect(deleteSavedView("view-1")).rejects.toThrow(
        "Forbidden: You do not have permission to delete this saved view",
      );

      // Verify delete was NEVER called
      expect(prisma.savedView.delete).not.toHaveBeenCalled();
    });
  });
});
