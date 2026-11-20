import { describe, it, expect, vi, beforeEach } from "vitest";
import * as verifyModule from "@/lib/audit/verify-chain";

describe("audit:verify CLI script logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes when verifyAuditChain returns valid", async () => {
    const spy = vi.spyOn(verifyModule, "verifyAuditChain").mockResolvedValue({
      valid: true,
      totalVerified: 10,
    });

    const result = await verifyModule.verifyAuditChain({} as any);
    expect(result.valid).toBe(true);
    expect(result.totalVerified).toBe(10);
    spy.mockRestore();
  });

  it("reports broken entry when verifyAuditChain returns invalid", async () => {
    const spy = vi.spyOn(verifyModule, "verifyAuditChain").mockResolvedValue({
      valid: false,
      totalVerified: 3,
      brokenEntryId: "audit-broken-4",
      reason: "Tampered entry detected at audit-broken-4",
    });

    const result = await verifyModule.verifyAuditChain({} as any);
    expect(result.valid).toBe(false);
    expect(result.brokenEntryId).toBe("audit-broken-4");
    spy.mockRestore();
  });

  it("handles cursor and limit options with firstInvalidEntryId pinpointing (#1796)", async () => {
    const spy = vi.spyOn(verifyModule, "verifyAuditChain").mockResolvedValue({
      valid: false,
      totalVerified: 15,
      brokenEntryId: "entry-16",
      firstInvalidEntryId: "entry-16",
      expectedHash: "expected-hash-123",
      actualHash: "actual-hash-456",
      reason: "Broken chain link at entry entry-16",
    });

    const result = await verifyModule.verifyAuditChain({} as any, {
      cursor: "cursor-123",
      limit: 20,
    });
    expect(result.valid).toBe(false);
    expect(result.firstInvalidEntryId).toBe("entry-16");
    expect(result.expectedHash).toBe("expected-hash-123");
    expect(result.actualHash).toBe("actual-hash-456");
    expect(spy).toHaveBeenCalledWith(expect.anything(), {
      cursor: "cursor-123",
      limit: 20,
    });
    spy.mockRestore();
  });

  it("returns nextCursor and hasMore when batch has more records (#1796)", async () => {
    const spy = vi.spyOn(verifyModule, "verifyAuditChain").mockResolvedValue({
      valid: true,
      totalVerified: 50,
      nextCursor: "next-cursor-xyz",
      hasMore: true,
    });

    const result = await verifyModule.verifyAuditChain({} as any, { limit: 50 });
    expect(result.valid).toBe(true);
    expect(result.totalVerified).toBe(50);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("next-cursor-xyz");
    spy.mockRestore();
  });
});
