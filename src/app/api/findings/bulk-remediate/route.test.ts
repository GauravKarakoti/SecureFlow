import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { authMock, findingFindMany, patchUpsert, generatePatchMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  findingFindMany: vi.fn(),
  patchUpsert: vi.fn(),
  generatePatchMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));

vi.mock("@/lib/prisma", () => ({
  default: {
    finding: { findMany: findingFindMany },
    remediationPatch: { upsert: patchUpsert },
  },
}));

vi.mock("@/ai/flows/generate-remediation-patch", () => ({
  generateRemediationPatchFlow: generatePatchMock,
}));

vi.mock("@/lib/middleware/rate-limit", () => ({
  TIERS: { AI_STREAM: { limit: 20, windowSeconds: 60, fallbackStrategy: "fail-closed" } },
  withRateLimit: <T>(handler: T): T => handler,
}));

import { POST } from "./route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/findings/bulk-remediate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/findings/bulk-remediate (#814)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-123" } });
  });

  it("returns 401 if user is unauthenticated", async () => {
    authMock.mockResolvedValue(null);
    const req = makeRequest({ findingIds: ["f-1"] });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("returns 400 for invalid or empty findingIds array", async () => {
    const resEmpty = await POST(makeRequest({ findingIds: [] }));
    expect(resEmpty.status).toBe(400);

    const resMissing = await POST(makeRequest({}));
    expect(resMissing.status).toBe(400);

    const resNonString = await POST(makeRequest({ findingIds: [123] }));
    expect(resNonString.status).toBe(400);
  });

  it("returns 404 when no findings match the IDs or user", async () => {
    findingFindMany.mockResolvedValue([]);
    const res = await POST(makeRequest({ findingIds: ["f-1"] }));
    expect(res.status).toBe(404);
  });

  it("returns 403 when some findings are not found or not owned by user", async () => {
    findingFindMany.mockResolvedValue([{ id: "f-1", type: "VULNERABILITY" }]);
    const res = await POST(makeRequest({ findingIds: ["f-1", "f-2"] }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/access is denied/i);
  });

  it("treats a repeated id as one finding instead of denying access", async () => {
    findingFindMany.mockResolvedValue([
      { id: "f-1", type: "SECRET", fileLocation: "src/keys.ts", codeSnippet: "k" },
    ]);
    generatePatchMock.mockResolvedValue({ patchDiff: "--- a/src/keys.ts", explanation: "e" });
    patchUpsert.mockResolvedValue({ findingId: "f-1", patchDiff: "--- a/src/keys.ts" });

    const res = await POST(makeRequest({ findingIds: ["f-1", "f-1"] }));

    expect(res.status).toBe(200);
    expect(findingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["f-1"] } }),
      }),
    );
    expect(generatePatchMock).toHaveBeenCalledTimes(1);
    expect((await res.json()).count).toBe(1);
  });

  it("rejects more findings than one page of the dashboard can select, before any lookup", async () => {
    const findingIds = Array.from({ length: 101 }, (_, i) => `f-${i}`);

    const res = await POST(makeRequest({ findingIds }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most 100/);
    expect(findingFindMany).not.toHaveBeenCalled();
    expect(generatePatchMock).not.toHaveBeenCalled();
  });

  it("accepts a full page of findings", async () => {
    const findingIds = Array.from({ length: 100 }, (_, i) => `f-${i}`);
    findingFindMany.mockResolvedValue([]);

    const res = await POST(makeRequest({ findingIds }));

    expect(res.status).toBe(404);
    expect(findingFindMany).toHaveBeenCalled();
  });

  it("returns 400 and rejects mixed vulnerability types", async () => {
    findingFindMany.mockResolvedValue([
      { id: "f-1", type: "SECRET", fileLocation: "src/keys.ts" },
      { id: "f-2", type: "VULNERABILITY", fileLocation: "src/auth.ts" },
    ]);
    const res = await POST(makeRequest({ findingIds: ["f-1", "f-2"] }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/same vulnerability type/i);
    expect(generatePatchMock).not.toHaveBeenCalled();
  });

  it("generates bulk remediation patches and returns combined diff for homogeneous types", async () => {
    findingFindMany.mockResolvedValue([
      {
        id: "f-1",
        type: "VULNERABILITY",
        fileLocation: "src/auth/token.ts",
        codeSnippet: "jwt.decode(token)",
        explanation: "Unverified token payload",
        remediation: "Verify signature",
      },
      {
        id: "f-2",
        type: "VULNERABILITY",
        fileLocation: "src/auth/session.ts",
        codeSnippet: "session.id = req.id",
        explanation: "Session fixation",
        remediation: "Regenerate session",
      },
    ]);

    generatePatchMock
      .mockResolvedValueOnce({
        patchDiff:
          "--- a/src/auth/token.ts\n+++ b/src/auth/token.ts\n@@ -1 +1 @@\n-jwt.decode\n+jwt.verify",
        explanation: "Verify token signature",
      })
      .mockResolvedValueOnce({
        patchDiff:
          "--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -1 +1 @@\n-session.id = req.id\n+session.regenerate()",
        explanation: "Regenerate session id",
      });

    patchUpsert.mockImplementation(async ({ where, create, update }) => ({
      ...create,
      ...update,
      id: `patch-${where.findingId}`,
    }));

    const res = await POST(makeRequest({ findingIds: ["f-1", "f-2"] }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.count).toBe(2);
    expect(data.type).toBe("VULNERABILITY");
    expect(data.patch.status).toBe("GENERATED");
    expect(data.patch.patchDiff).toContain("--- a/src/auth/token.ts");
    expect(data.patch.patchDiff).toContain("--- a/src/auth/session.ts");
    expect(data.explanation).toContain("Bulk remediation patch for 2 VULNERABILITY findings");

    expect(generatePatchMock).toHaveBeenCalledTimes(2);
    expect(patchUpsert).toHaveBeenCalledTimes(2);
  });
});
