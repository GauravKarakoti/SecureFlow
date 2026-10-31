import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  authMock,
  findingFindMany,
  remediationPatchUpdateMany,
  remediationPatchUpsert,
  armorClient,
  verifyIntentToken,
  transactionMock,
} = vi.hoisted(() => {
  const patchUpdateMany = vi.fn();
  const patchUpsert = vi.fn();
  const txMock = vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
    return await callback({
      remediationPatch: {
        updateMany: patchUpdateMany,
        upsert: patchUpsert,
      },
    });
  });

  return {
    authMock: vi.fn(),
    findingFindMany: vi.fn(),
    remediationPatchUpdateMany: patchUpdateMany,
    remediationPatchUpsert: patchUpsert,
    verifyIntentToken: vi.fn(),
    transactionMock: txMock,
    armorClient: {
      capturePlan: vi.fn(),
      getIntentToken: vi.fn(),
    },
  };
});

vi.mock("@/auth", () => ({ auth: authMock }));

vi.mock("@/lib/prisma", () => ({
  default: {
    finding: { findMany: findingFindMany },
    remediationPatch: {
      updateMany: remediationPatchUpdateMany,
      upsert: remediationPatchUpsert,
    },
    $transaction: transactionMock,
  },
}));

vi.mock("@/lib/armor/iq", () => ({
  ArmorIQService: {
    getClient: () => armorClient,
    verifyIntentToken,
  },
}));

const mockCheckRateLimitDetailed = vi.hoisted(() =>
  vi.fn(async () => ({
    allowed: true,
    limit: 10,
    remaining: 9,
    resetAt: Date.now() + 60_000,
    degraded: false,
  })),
);

vi.mock("@/lib/redis", () => ({
  checkRateLimitDetailed: mockCheckRateLimitDetailed,
}));

vi.mock("@/lib/middleware/rate-limit", () => ({
  TIERS: {
    AI_STREAM: { limit: 20, windowSeconds: 60, fallbackStrategy: "fail-closed" },
    AI_STREAM_USER: {
      limit: 10,
      windowSeconds: 60,
      fallbackStrategy: "fail-closed",
      timeoutMs: 1000,
    },
  },
  withRateLimit: <T>(handler: T): T => handler,
  buildRateLimitHeaders: vi.fn(() => ({ "X-RateLimit-Limit": "10" })),
  secondsUntilReset: vi.fn(() => 60),
}));

import { resetModelCircuitBreakers } from "@/ai/resilience";
import { POST } from "./route";

const mockFindings = [
  {
    id: "finding-1",
    type: "VULNERABILITY",
    fileLocation: "src/app/api/auth/route.ts",
    codeSnippet: "const secret = 'insecure';",
    explanation: "Hardcoded secret detected",
    remediationPatch: { patchDiff: "diff --git a/src/app/api/auth/route.ts b/src/app/api/auth/route.ts", status: "GENERATED" },
    scanResult: { pullRequest: { repository: { userId: "user-123" } } },
  },
  {
    id: "finding-2",
    type: "VULNERABILITY",
    fileLocation: "src/lib/db.ts",
    codeSnippet: "const query = `SELECT * FROM users WHERE id = ${id}`;",
    explanation: "SQL injection risk",
    remediationPatch: { patchDiff: "diff --git a/src/lib/db.ts b/src/lib/db.ts", status: "GENERATED" },
    scanResult: { pullRequest: { repository: { userId: "user-123" } } },
  },
  {
    id: "finding-3",
    type: "VULNERABILITY",
    fileLocation: "src/server/handler.ts",
    codeSnippet: "eval(userInput);",
    explanation: "Code execution vulnerability",
    remediationPatch: { patchDiff: "diff --git a/src/server/handler.ts b/src/server/handler.ts", status: "GENERATED" },
    scanResult: { pullRequest: { repository: { userId: "user-123" } } },
  },
];

const timeoutError = () =>
  Object.assign(new Error("ArmorIQ control plane policy verification timed out"), {
    name: "ArmorIQTimeoutError",
    status: 504,
  });

const networkError = () =>
  Object.assign(new Error("Connection reset by peer"), {
    name: "ArmorIQUnreachableError",
    code: "ECONNRESET",
    status: 502,
  });

function makeBulkRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/findings/bulk-remediate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/findings/bulk-remediate with ArmorIQ circuit breaker (#1488)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelCircuitBreakers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    authMock.mockResolvedValue({ user: { id: "user-123" } });
    findingFindMany.mockResolvedValue(mockFindings);
    remediationPatchUpdateMany.mockResolvedValue({ count: mockFindings.length });
    transactionMock.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => {
      return await callback({
        remediationPatch: {
          updateMany: remediationPatchUpdateMany,
          upsert: remediationPatchUpsert,
        },
      });
    });
    armorClient.capturePlan.mockReturnValue({ captured: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetModelCircuitBreakers();
  });

  it("blocks bulk remediation with 403 on a single ArmorIQ timeout and leaves database unchanged", async () => {
    armorClient.getIntentToken.mockRejectedValue(timeoutError());

    const response = await POST(
      makeBulkRequest({
        action: "apply",
        findingIds: ["finding-1", "finding-2", "finding-3"],
      }),
    );

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data).toEqual({
      error: "ArmorIQ authorization failed; remediation is blocked",
    });
    expect(remediationPatchUpdateMany).not.toHaveBeenCalled();
  });

  it("blocks bulk remediation with 403 on upstream network error without persisting changes", async () => {
    armorClient.getIntentToken.mockRejectedValue(networkError());

    const response = await POST(
      makeBulkRequest({
        action: "apply",
        findingIds: ["finding-1", "finding-2", "finding-3"],
      }),
    );

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe("ArmorIQ authorization failed; remediation is blocked");
    expect(remediationPatchUpdateMany).not.toHaveBeenCalled();
  });

  it("answers 503 without calling ArmorIQ once consecutive timeouts open the circuit", async () => {
    armorClient.getIntentToken.mockRejectedValue(timeoutError());

    // Trip circuit breaker with 3 consecutive upstream timeouts
    for (let i = 0; i < 3; i++) {
      const res = await POST(
        makeBulkRequest({
          action: "apply",
          findingIds: ["finding-1", "finding-2", "finding-3"],
        }),
      );
      expect(res.status).toBe(403);
    }
    expect(armorClient.getIntentToken).toHaveBeenCalledTimes(3);

    // Fourth request should immediately fail fast with 503 without invoking getIntentToken
    const response = await POST(
      makeBulkRequest({
        action: "apply",
        findingIds: ["finding-1", "finding-2", "finding-3"],
      }),
    );

    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data).toEqual({
      error: "ArmorIQ is temporarily unavailable; remediation is blocked",
    });
    expect(armorClient.getIntentToken).toHaveBeenCalledTimes(3);
    expect(remediationPatchUpdateMany).not.toHaveBeenCalled();
  });

  it("answers 503 when token verification reports ArmorIQ unavailable", async () => {
    armorClient.getIntentToken.mockResolvedValue({ rawToken: {}, planHash: "plan-hash-123" });
    verifyIntentToken.mockResolvedValue({
      valid: false,
      unavailable: true,
      reason: "ArmorIQ is temporarily unavailable (circuit open)",
    });

    const response = await POST(
      makeBulkRequest({
        action: "apply",
        findingIds: ["finding-1", "finding-2", "finding-3"],
      }),
    );

    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data).toEqual({
      error: "ArmorIQ is temporarily unavailable; remediation is blocked",
    });
    expect(remediationPatchUpdateMany).not.toHaveBeenCalled();
  });

  it("answers 403 when ArmorIQ is reachable but denies authorization", async () => {
    armorClient.getIntentToken.mockResolvedValue({ rawToken: {}, planHash: "plan-hash-123" });
    verifyIntentToken.mockResolvedValue({
      valid: false,
      unavailable: false,
      reason: "Action denied by policy rule",
    });

    const response = await POST(
      makeBulkRequest({
        action: "apply",
        findingIds: ["finding-1", "finding-2", "finding-3"],
      }),
    );

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data).toEqual({
      error: "ArmorIQ intent verification failed; remediation is blocked",
    });
    expect(remediationPatchUpdateMany).not.toHaveBeenCalled();
  });

  it("normal policy rejections do not increment circuit breaker failure count", async () => {
    armorClient.getIntentToken.mockResolvedValue({ rawToken: {}, planHash: "plan-hash-123" });
    verifyIntentToken.mockResolvedValue({
      valid: false,
      unavailable: false,
      reason: "Action denied by security boundary",
    });

    for (let i = 0; i < 5; i++) {
      const res = await POST(
        makeBulkRequest({
          action: "apply",
          findingIds: ["finding-1", "finding-2", "finding-3"],
        }),
      );
      expect(res.status).toBe(403);
    }

    // Still calls upstream because the circuit did NOT trip
    expect(armorClient.getIntentToken).toHaveBeenCalledTimes(5);
  });

  it("rolls back partial batch database updates atomically if transaction fails", async () => {
    armorClient.getIntentToken.mockResolvedValue({ rawToken: {}, planHash: "plan-hash-123" });
    verifyIntentToken.mockResolvedValue({ valid: true });

    // Simulate transaction error midway
    transactionMock.mockRejectedValueOnce(new Error("Database transaction rolled back"));

    const response = await POST(
      makeBulkRequest({
        action: "apply",
        findingIds: ["finding-1", "finding-2", "finding-3"],
      }),
    );

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe("Internal Server Error");
  });

  it("successfully applies bulk remediation when ArmorIQ authorizes the plan", async () => {
    armorClient.getIntentToken.mockResolvedValue({ rawToken: {}, planHash: "plan-hash-123" });
    verifyIntentToken.mockResolvedValue({ valid: true });

    const response = await POST(
      makeBulkRequest({
        action: "apply",
        findingIds: ["finding-1", "finding-2", "finding-3"],
      }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      success: true,
      updatedCount: 3,
      status: "APPLIED",
    });
    expect(remediationPatchUpdateMany).toHaveBeenCalledWith({
      where: { findingId: { in: ["finding-1", "finding-2", "finding-3"] } },
      data: { status: "APPLIED" },
    });
  });

  it("allows rollback without requiring ArmorIQ minting token", async () => {
    const response = await POST(
      makeBulkRequest({
        action: "rollback",
        findingIds: ["finding-1", "finding-2", "finding-3"],
      }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      success: true,
      updatedCount: 3,
      status: "PENDING",
    });
    expect(armorClient.getIntentToken).not.toHaveBeenCalled();
    expect(remediationPatchUpdateMany).toHaveBeenCalledWith({
      where: { findingId: { in: ["finding-1", "finding-2", "finding-3"] } },
      data: { status: "PENDING" },
    });
  });
});
