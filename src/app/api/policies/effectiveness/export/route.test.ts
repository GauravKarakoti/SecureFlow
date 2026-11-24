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

describe("GET /api/policies/effectiveness/export (#2019)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(apiTokenModule.authenticateUserOrToken).mockResolvedValueOnce({
      ok: false,
      status: 401,
      message: "Authentication required",
    } as any);

    const req = new NextRequest("http://localhost:3000/api/policies/effectiveness/export");
    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it("returns 200 with text/csv content-type and disposition header", async () => {
    vi.mocked(apiTokenModule.authenticateUserOrToken).mockResolvedValueOnce({
      ok: true,
      userId: "user-1",
      method: "session",
    } as any);

    const mockSummary: effectivenessModule.PolicyEffectivenessSummary = {
      periodDays: 30,
      totalPolicies: 1,
      activePolicies: 1,
      noisyPolicies: 1,
      inactivePolicies: 0,
      healthyPolicies: 0,
      totalFindingsEvaluated: 4,
      overallFalsePositiveRate: 75,
      overallResolvedRate: 25,
      policies: [
        {
          policyId: "pol-1",
          policyName: "=CMD|' /C calc'!A0", // Malicious formula payload
          description: "+1337 Excel Injection", // Leading +
          severity: "-HIGH", // Leading -
          isActive: true,
          totalFindings: 4,
          falsePositiveCount: 3,
          falsePositiveRate: 75,
          resolvedCount: 1,
          resolvedRate: 25,
          openCount: 0,
          avgResolutionTimeMs: 14400000,
          avgResolutionTimeFormatted: "@4.0h", // Leading @
          status: "noisy",
        },
      ],
    };

    vi.mocked(effectivenessModule.fetchPolicyEffectivenessData).mockResolvedValueOnce(mockSummary);

    const req = new NextRequest("http://localhost:3000/api/policies/effectiveness/export?days=30");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="policy-effectiveness-report-30d.csv"',
    );

    const csvText = await res.text();

    // Verify formula-injection protection in CSV response:
    // Leading '=', '+', '-', '@' must be neutralized with a leading single quote '\''
    expect(csvText).toContain("Policy ID,Policy Name,Severity,Status");
    expect(csvText).toContain("'=CMD|' /C calc'!A0");
    expect(csvText).toContain("'+1337 Excel Injection");
    expect(csvText).toContain("'-HIGH");
    expect(csvText).toContain("'@4.0h");
  });
});
