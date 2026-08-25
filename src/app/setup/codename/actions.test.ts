import { describe, it, expect, vi, beforeEach } from "vitest";
import { setCrewCodename } from "./actions";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { auth } from "@/auth";
import prisma from "@/lib/prisma";

describe("setCrewCodename Server Action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error if unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as any);

    const result = await setCrewCodename("Tokyo");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Authentication required");
  });

  it("returns error if codename is empty or whitespace", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "user-123", email: "recruit@vault.test" },
    } as any);

    const result = await setCrewCodename("   ");
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot be empty");
  });

  it("returns error if codename is too short or too long", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "user-123", email: "recruit@vault.test" },
    } as any);

    const shortRes = await setCrewCodename("A");
    expect(shortRes.success).toBe(false);
    expect(shortRes.error).toContain("between 2 and 30 characters");

    const longRes = await setCrewCodename("A".repeat(35));
    expect(longRes.success).toBe(false);
    expect(longRes.error).toContain("between 2 and 30 characters");
  });

  it("returns error if codename has invalid characters", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "user-123", email: "recruit@vault.test" },
    } as any);

    const result = await setCrewCodename("Tokyo<script>");
    expect(result.success).toBe(false);
    expect(result.error).toContain("can only contain letters, numbers");
  });

  it("returns error if codename is already taken by another user", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "user-123", email: "recruit@vault.test" },
    } as any);

    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "other-user-456",
      codename: "Berlin",
    } as any);

    const result = await setCrewCodename("Berlin");
    expect(result.success).toBe(false);
    expect(result.error).toContain('already taken');
  });

  it("successfully sets and capitalizes codename and logs audit event", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "user-123", email: "recruit@vault.test" },
    } as any);

    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ codename: null } as any);
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: "user-123",
      codename: "Tokyo",
    } as any);

    const result = await setCrewCodename("tokyo");
    expect(result.success).toBe(true);
    expect(result.codename).toBe("Tokyo");

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-123" },
      data: { codename: "Tokyo" },
    });

    // The entry now goes through sanitizeAuditLogInput like every other write
    // in the project, so the persisted shape is whatever the minimiser produces
    // rather than the raw literal — assert the fields that matter.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = vi.mocked(prisma.auditLog.create).mock.calls[0][0] as any;
    expect(auditArgs.data).toMatchObject({
      action: "CREW_CODENAME_ASSIGNED",
      decision: "PASS",
    });
    expect(auditArgs.data.metadata).toMatchObject({
      assignedCodename: "Tokyo",
      previousCodename: null,
    });
  });
});
