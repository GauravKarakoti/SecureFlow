import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { authMock, findingFindFirst, userFindUnique } = vi.hoisted(() => ({
  authMock: vi.fn(),
  findingFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma", () => ({
  default: {
    finding: { findFirst: findingFindFirst },
    user: { findUnique: userFindUnique },
  },
}));

import { POST } from "./route";

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/findings/finding-1/remediate/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/findings/[id]/remediate/apply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("requires an authenticated user and explicit approval", async () => {
    authMock.mockResolvedValueOnce(null);
    const unauthorized = await POST(makeRequest({ approved: true }), {
      params: Promise.resolve({ id: "finding-1" }),
    });
    expect(unauthorized.status).toBe(401);

    const unapproved = await POST(makeRequest({ approved: false }), {
      params: Promise.resolve({ id: "finding-1" }),
    });
    expect(unapproved.status).toBe(400);
    expect(findingFindFirst).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the owner and rejects paths outside src before GitHub access", async () => {
    findingFindFirst.mockResolvedValue({
      id: "finding-1",
      type: "VULNERABILITY",
      fileLocation: ".github/workflows/ci.yml",
      explanation: "unsafe workflow",
      remediationPatch: { patchDiff: "diff", status: "GENERATED" },
      scanResult: { pullRequest: { repository: { fullName: "owner/repo" } } },
    });

    const response = await POST(makeRequest({ approved: true }), {
      params: Promise.resolve({ id: "finding-1" }),
    });

    expect(response.status).toBe(403);
    expect(findingFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "finding-1",
          scanResult: { pullRequest: { repository: { userId: "user-1" } } },
        },
      }),
    );
    expect(userFindUnique).not.toHaveBeenCalled();
  });
});