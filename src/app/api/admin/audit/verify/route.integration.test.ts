import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { AUDIT_LOG_GENESIS_HASH, computeAuditEntryHash } from "@/lib/audit/audit-chain";
import { GET } from "./route";

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "admin-1", roles: ["ADMIN"] } })),
}));

const findRows = vi.mocked(prisma.auditLog.findMany);

function signedEntry(id: string, timestamp: Date, previousHash: string) {
  const values = {
    timestamp,
    previousHash,
    action: "CHECK_COMPLETE",
    userId: "account-1",
    resource: "example",
    decision: "allow",
    metadata: null,
  };
  return { id, ...values, entryHash: computeAuditEntryHash(values) };
}

function verify() {
  return GET(new NextRequest("http://localhost:3000/api/admin/audit/verify?limit=10"));
}

describe("audit verification route with signed entries", () => {
  const first = signedEntry("row-1", new Date("2026-08-20T12:00:00Z"), AUDIT_LOG_GENESIS_HASH);
  const second = signedEntry("row-2", new Date("2026-08-20T12:01:00Z"), first.entryHash);

  beforeEach(() => findRows.mockClear());

  it("accepts the intact chain using the chronological database order", async () => {
    findRows.mockResolvedValueOnce([first, second]);
    const response = await verify();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "VALID",
      valid: true,
      totalVerified: 2,
    });
    expect(findRows).toHaveBeenCalledOnce();
    expect(findRows).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ timestamp: "asc" }, { id: "asc" }],
        take: 11,
      }),
    );
  });

  it("identifies a changed row using the real hash verifier", async () => {
    findRows.mockResolvedValueOnce([first, { ...second, decision: "deny" }]);
    const response = await verify();
    const result = await response.json();

    expect(response.status).toBe(409);
    expect(result).toMatchObject({
      status: "COMPROMISED",
      valid: false,
      totalVerified: 1,
      firstInvalidEntryId: second.id,
      actualHash: second.entryHash,
      reason: expect.stringContaining("Tampered entry"),
    });
    expect(result.expectedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.expectedHash).not.toBe(result.actualHash);
  });

  it("rejects valid hashes when the chronological order contradicts the chain links", async () => {
    const earlierSecond = signedEntry("row-2", new Date("2026-08-20T11:59:00Z"), first.entryHash);
    findRows.mockResolvedValueOnce([earlierSecond, first]);
    const response = await verify();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: "COMPROMISED",
      valid: false,
      totalVerified: 0,
      firstInvalidEntryId: earlierSecond.id,
      reason: expect.stringContaining("Broken chain link"),
      expectedHash: AUDIT_LOG_GENESIS_HASH,
      actualHash: first.entryHash,
    });
  });
});
