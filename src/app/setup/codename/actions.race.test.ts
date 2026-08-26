/**
 * The write path of the Naming Ceremony (#646).
 *
 * `actions.test.ts` covers validation and the happy path. This file covers the
 * part that was broken: what happens when the advisory pre-check passes and the
 * database disagrees.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setCrewCodename } from "./actions";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  default: {
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { auth } from "@/auth";
import prisma from "@/lib/prisma";

/** A Prisma unique-constraint violation, in the shape the Postgres client emits. */
function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed on the fields: (`codename`)"), {
    code: "P2002",
    meta: { target: ["codename"] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-123" } } as any);
  vi.mocked(prisma.user.findFirst).mockResolvedValue(null as any);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ codename: null } as any);
  vi.mocked(prisma.user.update).mockResolvedValue({ id: "user-123" } as any);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);
});

describe("setCrewCodename — losing the race", () => {
  it("reports a lost race as 'already taken', not as a vault failure", async () => {
    // Two recruits submit "Tokyo" at the same time. Both see findFirst return
    // null, both call update, and the second one hits the unique index. The old
    // code caught this in the catch-all and told the user to "try again", which
    // for the same codename fails forever and gives them no way to learn that
    // the fix is to pick a different name.
    vi.mocked(prisma.user.update).mockRejectedValue(uniqueViolation());

    const result = await setCrewCodename("Tokyo");

    expect(result.success).toBe(false);
    expect(result.error).toContain("already taken");
    expect(result.error).toContain("Tokyo");
    expect(result.error).not.toContain("try again");
  });

  it("handles a P2002 that carries no target", async () => {
    vi.mocked(prisma.user.update).mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );

    const result = await setCrewCodename("Tokyo");

    expect(result.error).toContain("already taken");
  });

  it("still reports a genuine database failure as one", async () => {
    // A lost race and a broken connection are different problems, and "try
    // again" is the right advice for exactly one of them.
    vi.mocked(prisma.user.update).mockRejectedValue(new Error("connection terminated"));

    const result = await setCrewCodename("Tokyo");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Vault registry");
  });

  it("does not write an audit entry for a claim that failed", async () => {
    vi.mocked(prisma.user.update).mockRejectedValue(uniqueViolation());

    await setCrewCodename("Tokyo");

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("setCrewCodename — the pre-check", () => {
  it("short-circuits without a write when the codename is visibly taken", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "other-user" } as any);

    const result = await setCrewCodename("Berlin");

    expect(result.success).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("compares case-insensitively against the canonical form", async () => {
    await setCrewCodename("TOKYO two");

    const args = vi.mocked(prisma.user.findFirst).mock.calls[0][0] as any;
    expect(args.where.codename).toEqual({ equals: "Tokyo Two", mode: "insensitive" });
    expect(args.where.NOT).toEqual({ id: "user-123" });
  });

  it("stores the canonical form, not what was typed", async () => {
    // The database's unique index is case sensitive, so this is what makes the
    // constraint enforce the rule the application claims to enforce.
    await setCrewCodename("  tOkYo   TwO  ");

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-123" },
      data: { codename: "Tokyo Two" },
    });
  });
});

describe("setCrewCodename — the audit entry", () => {
  it("reads the previous codename from the row, not the session", async () => {
    // session.user.codename is whatever was in the JWT when the page rendered,
    // so the audit trail's "previous" value was routinely stale or absent.
    vi.mocked(auth).mockResolvedValue({
      user: { id: "user-123", codename: "StaleFromToken" },
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ codename: "Berlin" } as any);

    await setCrewCodename("Tokyo");

    const args = vi.mocked(prisma.auditLog.create).mock.calls[0][0] as any;
    expect(args.data.metadata.previousCodename).toBe("Berlin");
  });

  it("succeeds even when the audit write fails", async () => {
    // The codename is already committed; failing now would tell the user their
    // claim did not work when it did.
    vi.mocked(prisma.auditLog.create).mockRejectedValue(new Error("audit table locked"));

    const result = await setCrewCodename("Tokyo");

    expect(result).toEqual({ success: true, codename: "Tokyo" });
  });
});

describe("setCrewCodename — reserved names", () => {
  it("refuses a reserved name without touching the database", async () => {
    const result = await setCrewCodename("SecureFlow");

    expect(result.success).toBe(false);
    expect(result.error).toContain("reserved");
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("refuses a reserved name spelled around the separators", async () => {
    expect((await setCrewCodename("secure-flow")).success).toBe(false);
    expect((await setCrewCodename("ad_min")).success).toBe(false);
  });

  it("still allows the actual city codenames", async () => {
    expect((await setCrewCodename("Nairobi")).success).toBe(true);
  });
});
