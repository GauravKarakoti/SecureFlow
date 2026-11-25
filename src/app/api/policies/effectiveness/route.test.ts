import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import * as apiTokenModule from "@/lib/auth/api-token";
import * as effectivenessModule from "@/lib/policies/effectiveness";

vi.mock("@/lib/auth/api-token", () => ({
  authenticateUserOrToken: vi.fn(),
}));

vi.mock("@/lib/policies/effectiveness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/policies/effectiveness")>();
  return {
    ...actual,
    fetchPolicyEffectivenessData: vi.fn(),
  };
});

describe("GET /api/policies/effectiveness (#2019)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(apiTokenModule.authenticateUserOrToken).mockResolvedValueOnce({
      ok: false,
      status: 401,
      message: "Authentication required",
    } as any);

    const req = new NextRequest("http://localhost:3000/api/policies/effectiveness");
    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it("returns 200 with summary for authenticated user", async () => {
    vi.mocked(apiTokenModule.authenticateUserOrToken).mockResolvedValueOnce({
      ok: true,
      userId: "user-1",
      method: "session",
    } as any);

    const mockSummary: any = {
      periodDays: 30,
      totalPolicies: 5,
      noisyPolicies: 1,
      inactivePolicies: 2,
      healthyPolicies: 2,
      policies: [],
    };

    vi.mocked(effectivenessModule.fetchPolicyEffectivenessData).mockResolvedValueOnce(mockSummary);

    const req = new NextRequest("http://localhost:3000/api/policies/effectiveness?days=30");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.periodDays).toBe(30);
    expect(data.noisyPolicies).toBe(1);
    expect(effectivenessModule.fetchPolicyEffectivenessData).toHaveBeenCalledWith("user-1", 30);
  });

  it("accepts custom days query param (e.g. 7)", async () => {
    vi.mocked(apiTokenModule.authenticateUserOrToken).mockResolvedValueOnce({
      ok: true,
      userId: "user-1",
      method: "session",
    } as any);

    vi.mocked(effectivenessModule.fetchPolicyEffectivenessData).mockResolvedValueOnce({
      periodDays: 7,
    } as any);

    const req = new NextRequest("http://localhost:3000/api/policies/effectiveness?days=7");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(effectivenessModule.fetchPolicyEffectivenessData).toHaveBeenCalledWith("user-1", 7);
  });
});
