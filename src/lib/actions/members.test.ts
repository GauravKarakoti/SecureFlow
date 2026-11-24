import { describe, it, expect, vi, beforeEach } from "vitest";
import { getInstallationMembers, updateMemberRole } from "./members";
import { PermissionDeniedError } from "@/lib/auth/permissions";

const {
  authMock,
  userFindManyMock,
  userFindUniqueMock,
  userCountMock,
  userRoleDeleteManyMock,
  userRoleCreateMock,
  roleUpsertMock,
  roleFindUniqueMock,
  auditLogCreateMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  userFindManyMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  userCountMock: vi.fn(),
  userRoleDeleteManyMock: vi.fn(),
  userRoleCreateMock: vi.fn(),
  roleUpsertMock: vi.fn(),
  roleFindUniqueMock: vi.fn(),
  auditLogCreateMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));

vi.mock("@/lib/prisma", () => ({
  default: {
    user: {
      findMany: userFindManyMock,
      findUnique: userFindUniqueMock,
      count: userCountMock,
    },
    userRole: {
      deleteMany: userRoleDeleteManyMock,
      create: userRoleCreateMock,
    },
    role: {
      upsert: roleUpsertMock,
      findUnique: roleFindUniqueMock,
    },
    auditLog: {
      create: auditLogCreateMock,
    },
    $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => {
      return cb({
        user: { count: userCountMock },
        userRole: {
          deleteMany: userRoleDeleteManyMock,
          create: userRoleCreateMock,
        },
        role: {
          upsert: roleUpsertMock,
          findUnique: roleFindUniqueMock,
        },
        auditLog: {
          create: auditLogCreateMock,
        },
      });
    }),
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

describe("Member Management & Role Actions (#1922)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getInstallationMembers", () => {
    it("throws unauthorized when caller is not signed in", async () => {
      authMock.mockResolvedValueOnce(null);
      await expect(getInstallationMembers()).rejects.toThrow("Unauthorized");
    });

    it("fetches members and resolves their canonical installation roles", async () => {
      authMock.mockResolvedValueOnce({ user: { id: "u-admin", roles: ["ADMIN"] } });
      userFindManyMock.mockResolvedValueOnce([
        {
          id: "u-1",
          name: "Alice Admin",
          email: "alice@example.com",
          codename: "TOKYO",
          image: null,
          roles: [{ role: { name: "ADMIN" } }],
          repositories: [{ id: "repo-1" }],
          createdAt: new Date("2026-01-01"),
        },
        {
          id: "u-2",
          name: "Bob Triager",
          email: "bob@example.com",
          codename: "DENVER",
          image: null,
          roles: [{ role: { name: "TRIAGER" } }],
          repositories: [],
          createdAt: new Date("2026-01-02"),
        },
        {
          id: "u-3",
          name: "Charlie Viewer",
          email: "charlie@example.com",
          codename: "OSLO",
          image: null,
          roles: [{ role: { name: "VIEWER" } }],
          repositories: [],
          createdAt: new Date("2026-01-03"),
        },
      ]);

      const members = await getInstallationMembers();
      expect(members).toHaveLength(3);
      expect(members[0].role).toBe("ADMIN");
      expect(members[1].role).toBe("TRIAGER");
      expect(members[2].role).toBe("VIEWER");
    });
  });

  describe("updateMemberRole", () => {
    it("rejects non-admin callers (VIEWER or TRIAGER) with PermissionDeniedError", async () => {
      authMock.mockResolvedValueOnce({ user: { id: "u-viewer", roles: ["VIEWER"] } });

      await expect(updateMemberRole("u-target", "TRIAGER")).rejects.toThrow(PermissionDeniedError);

      authMock.mockResolvedValueOnce({ user: { id: "u-triager", roles: ["TRIAGER"] } });
      await expect(updateMemberRole("u-target", "VIEWER")).rejects.toThrow(PermissionDeniedError);
    });

    it("allows ADMIN to update member roles and records audit log", async () => {
      authMock.mockResolvedValueOnce({ user: { id: "admin-1", roles: ["ADMIN"] } });
      userFindUniqueMock.mockResolvedValueOnce({
        id: "u-2",
        email: "bob@example.com",
        codename: "DENVER",
        roles: [{ role: { name: "VIEWER" } }],
      });
      userCountMock.mockResolvedValue(2);
      roleUpsertMock.mockResolvedValueOnce({ id: "role-triager", name: "TRIAGER" });

      const result = await updateMemberRole("u-2", "TRIAGER");
      expect(result).toEqual({ success: true });

      expect(userRoleDeleteManyMock).toHaveBeenCalledWith({ where: { userId: "u-2" } });
      expect(userRoleCreateMock).toHaveBeenCalledWith({
        data: { userId: "u-2", roleId: "role-triager" },
      });

      expect(auditLogCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "admin-1",
            action: "MEMBER_ROLE_UPDATE",
            resource: "user:u-2",
            decision: "TRIAGER",
          }),
        }),
      );
    });

    it("prevents self-demotion from ADMIN", async () => {
      authMock.mockResolvedValueOnce({ user: { id: "admin-1", roles: ["ADMIN"] } });

      await expect(updateMemberRole("admin-1", "VIEWER")).rejects.toThrow(
        "You cannot remove your own admin role",
      );
    });

    it("prevents demoting the last remaining ADMIN", async () => {
      authMock.mockResolvedValueOnce({ user: { id: "admin-1", roles: ["ADMIN"] } });
      userFindUniqueMock.mockResolvedValueOnce({
        id: "admin-2",
        email: "other@example.com",
        codename: "BERLIN",
        roles: [{ role: { name: "ADMIN" } }],
      });
      userCountMock.mockResolvedValueOnce(1); // Only 1 admin remains

      await expect(updateMemberRole("admin-2", "VIEWER")).rejects.toThrow(
        "Cannot demote the last remaining administrator",
      );
    });
  });
});
