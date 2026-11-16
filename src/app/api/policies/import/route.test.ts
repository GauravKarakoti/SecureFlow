import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET as exportHandler } from "../export/route";
import { POST as previewHandler } from "./preview/route";
import { POST as importHandler } from "./route";
import { NextRequest } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

const mockFindManyTemplates = vi.hoisted(() => vi.fn());
const mockFindManyToggles = vi.hoisted(() => vi.fn());
const mockCreateTemplate = vi.hoisted(() => vi.fn());
const mockUpdateTemplate = vi.hoisted(() => vi.fn());
const mockUpsertToggle = vi.hoisted(() => vi.fn());
const mockAuditCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => {
  const db: any = {
    policyTemplate: {
      findMany: mockFindManyTemplates,
      create: mockCreateTemplate,
      update: mockUpdateTemplate,
    },
    userPolicyToggle: {
      findMany: mockFindManyToggles,
      upsert: mockUpsertToggle,
    },
    auditLog: {
      create: mockAuditCreate,
    },
    $transaction: vi.fn(async (cb: any) => cb(db)),
  };
  return { default: db };
});

vi.mock("@/lib/policies/policy-cache", () => ({
  invalidatePolicyCache: vi.fn(async () => {}),
}));

describe("Policies Export and Import API Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/policies/export", () => {
    it("returns 401 when user is not authenticated", async () => {
      vi.mocked(auth).mockResolvedValue(null);
      const req = new NextRequest("http://localhost:3000/api/policies/export");
      const res = await exportHandler(req);
      expect(res.status).toBe(401);
    });

    it("exports versioned policy set without internal ids or user data", async () => {
      vi.mocked(auth).mockResolvedValue({
        user: { id: "user-123", email: "alice@example.com" },
      } as any);

      mockFindManyTemplates.mockResolvedValue([
        {
          id: "tpl-1",
          name: "Block Secrets",
          description: "Detects secrets",
          severity: "CRITICAL",
          action: "DENY",
          rules: ["secrets/*"],
          complianceTags: ["SOC 2"],
          isDefault: false,
        },
      ]);

      mockFindManyToggles.mockResolvedValue([
        {
          policyTemplateId: "tpl-1",
          isActive: true,
        },
      ]);

      const req = new NextRequest("http://localhost:3000/api/policies/export");
      const res = await exportHandler(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");

      const body = await res.json();
      expect(body.version).toBe("1.0");
      expect(body.policies).toHaveLength(1);
      expect(body.policies[0]).toEqual({
        name: "Block Secrets",
        description: "Detects secrets",
        severity: "CRITICAL",
        enabled: true,
        action: "DENY",
        rules: ["secrets/*"],
        complianceTags: ["SOC 2"],
      });
      // Ensure internal id and user references are omitted
      expect(body.policies[0].id).toBeUndefined();
      expect(body.policies[0].userId).toBeUndefined();
    });
  });

  describe("POST /api/policies/import/preview", () => {
    it("rejects oversized payloads with 413", async () => {
      vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as any);
      const largeString = "a".repeat(1024 * 1024 + 10);
      const req = new NextRequest("http://localhost:3000/api/policies/import/preview", {
        method: "POST",
        body: largeString,
      });

      const res = await previewHandler(req);
      expect(res.status).toBe(413);
    });

    it("rejects unknown malicious fields with 400", async () => {
      vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as any);
      const payload = {
        version: "1.0",
        policies: [
          {
            name: "Good Policy",
            description: "Test",
            severity: "HIGH",
            enabled: true,
            maliciousScript: "alert(1)",
          },
        ],
      };
      const req = new NextRequest("http://localhost:3000/api/policies/import/preview", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const res = await previewHandler(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("Unrecognized key");
    });

    it("returns correct preview breakdown for valid file", async () => {
      vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as any);
      mockFindManyTemplates.mockResolvedValue([
        {
          id: "tpl-1",
          name: "Existing Policy",
          description: "Old description",
          severity: "HIGH",
          action: "REVIEW REQUIRED",
          isDefault: true,
        },
      ]);
      mockFindManyToggles.mockResolvedValue([]);

      const payload = {
        version: "1.0",
        policies: [
          {
            name: "Existing Policy",
            description: "New description",
            severity: "HIGH",
            enabled: true,
          },
          {
            name: "Brand New Policy",
            description: "New description",
            severity: "LOW",
            enabled: false,
          },
        ],
      };

      const req = new NextRequest("http://localhost:3000/api/policies/import/preview", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const res = await previewHandler(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.valid).toBe(true);
      expect(body.toUpdate).toBe(1);
      expect(body.toCreate).toBe(1);
    });
  });

  describe("POST /api/policies/import", () => {
    it("applies policy imports in database transaction and updates user toggles", async () => {
      vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as any);
      mockFindManyTemplates.mockResolvedValue([]);
      mockCreateTemplate.mockResolvedValue({ id: "tpl-created-1" });

      const payload = {
        version: "1.0",
        policies: [
          {
            name: "Brand New Policy",
            description: "Created via import",
            severity: "HIGH",
            enabled: true,
          },
        ],
      };

      const req = new NextRequest("http://localhost:3000/api/policies/import", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const res = await importHandler(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.createdCount).toBe(1);

      expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
      expect(mockUpsertToggle).toHaveBeenCalledWith({
        where: {
          userId_policyTemplateId: {
            userId: "user-1",
            policyTemplateId: "tpl-created-1",
          },
        },
        update: { isActive: true },
        create: {
          userId: "user-1",
          policyTemplateId: "tpl-created-1",
          isActive: true,
        },
      });
      expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    });
  });
});
