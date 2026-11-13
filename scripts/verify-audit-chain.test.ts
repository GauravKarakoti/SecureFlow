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
});
