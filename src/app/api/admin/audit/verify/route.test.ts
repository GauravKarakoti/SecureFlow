import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import { auth } from "@/auth";
import * as verifyModule from "@/lib/audit/verify-chain";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/audit/verify-chain", () => ({
  verifyAuditChain: vi.fn(),
}));

describe("GET /api/admin/audit/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthorized requests with 401 when unauthenticated", async () => {
    (auth as any).mockResolvedValue(null);
    const req = new NextRequest("http://localhost:3000/api/admin/audit/verify");
    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it("rejects non-admin users with 401", async () => {
    (auth as any).mockResolvedValue({
      user: { id: "user-1", roles: ["USER"] },
    });
    const req = new NextRequest("http://localhost:3000/api/admin/audit/verify");
    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it("returns 200 with VALID status when hash chain is intact", async () => {
    (auth as any).mockResolvedValue({
      user: { id: "admin-1", roles: ["ADMIN"] },
    });
    vi.mocked(verifyModule.verifyAuditChain).mockResolvedValue({
      valid: true,
      totalVerified: 42,
    });

    const req = new NextRequest("http://localhost:3000/api/admin/audit/verify");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      status: "VALID",
      valid: true,
      totalVerified: 42,
    });
  });

  it("returns 409 with COMPROMISED status when hash chain is broken", async () => {
    (auth as any).mockResolvedValue({
      user: { id: "admin-1", roles: ["ADMIN"] },
    });
    vi.mocked(verifyModule.verifyAuditChain).mockResolvedValue({
      valid: false,
      totalVerified: 5,
      brokenEntryId: "audit-broken-6",
      reason: "Tampered entry detected at audit-broken-6",
    });

    const req = new NextRequest("http://localhost:3000/api/admin/audit/verify");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      status: "COMPROMISED",
      valid: false,
      totalVerified: 5,
      brokenEntryId: "audit-broken-6",
      reason: "Tampered entry detected at audit-broken-6",
    });
  });
});
