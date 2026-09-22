import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockSession: { user: { id: string } } | null = { user: { id: "user-1" } };

vi.mock("@/auth", () => ({ auth: vi.fn(async () => mockSession) }));

const mockFindFirst = vi.hoisted(() => vi.fn());
const mockUpsert = vi.hoisted(() => vi.fn());
const generatePatchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  default: {
    finding: { findFirst: mockFindFirst },
    remediationPatch: { upsert: mockUpsert },
  },
}));

vi.mock("@/ai/flows/generate-remediation-patch", () => ({
  generateRemediationPatchFlow: generatePatchMock,
}));

vi.mock("@/lib/middleware/rate-limit", () => ({
  withRateLimit: vi.fn((handler: any) => handler),
  TIERS: { AI_STREAM: { limit: 10, windowSeconds: 60 } },
}));

vi.mock("@/lib/middleware/error-handler", () => ({
  withErrorHandler: vi.fn((handler: any) => handler),
  AppError: class AppError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
    }
  },
}));

import { POST } from "./route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(id: string) {
  return new NextRequest(`http://localhost/api/findings/${id}/remediate`, {
    method: "POST",
  });
}

// Shaped like a real `Finding` row. The fixture used to carry a `description`,
// which the table does not have, and that is what hid the route's invalid select.
const FINDING = {
  id: "finding-1",
  type: "VULNERABILITY",
  codeSnippet: "db.query('SELECT * FROM users WHERE id = ' + id)",
  explanation: "SQL injection via string concatenation",
  remediation: "Use a parameterized query.",
  fileLocation: "src/db.ts",
};

/** Every scalar column of `model Finding` in prisma/schema.prisma. */
const FINDING_COLUMNS = [
  "id",
  "scanResultId",
  "type",
  "severity",
  "fileLocation",
  "lineStart",
  "lineEnd",
  "codeSnippet",
  "explanation",
  "remediation",
  "promptInjectionSuspected",
  "fingerprint",
  "createdAt",
];

const PATCH = {
  id: "patch-1",
  findingId: "finding-1",
  patchDiff: "--- a/src/db.ts\n+++ b/src/db.ts",
  status: "GENERATED",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSession = { user: { id: "user-1" } };
  mockFindFirst.mockResolvedValue(FINDING);
  mockUpsert.mockResolvedValue(PATCH);
  generatePatchMock.mockResolvedValue({
    patchDiff: "--- a/src/db.ts\n+++ b/src/db.ts",
    explanation: "Use parameterized queries.",
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("POST /api/findings/[id]/remediate — authentication", () => {
  it("throws 401 when no session", async () => {
    mockSession = null;

    await expect(
      POST(makeRequest("finding-1"), { params: Promise.resolve({ id: "finding-1" }) }),
    ).rejects.toMatchObject({ statusCode: 401 });

    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Ownership check (IDOR/BOLA fix)
// ---------------------------------------------------------------------------

describe("POST /api/findings/[id]/remediate — ownership check", () => {
  it("scopes the finding lookup to the session userId via relation chain", async () => {
    await POST(makeRequest("finding-1"), { params: Promise.resolve({ id: "finding-1" }) });

    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "finding-1",
          scanResult: {
            pullRequest: {
              repository: { userId: "user-1" },
            },
          },
        },
      }),
    );
  });

  it("throws 404 when finding belongs to a different user (not 403 — no oracle)", async () => {
    mockFindFirst.mockResolvedValue(null);

    await expect(
      POST(makeRequest("other-users-finding"), {
        params: Promise.resolve({ id: "other-users-finding" }),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(generatePatchMock).not.toHaveBeenCalled();
  });

  it("throws 404 when finding does not exist", async () => {
    mockFindFirst.mockResolvedValue(null);

    await expect(
      POST(makeRequest("nonexistent"), { params: Promise.resolve({ id: "nonexistent" }) }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(generatePatchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Correct field name (fileLocation not filePath)
// ---------------------------------------------------------------------------

describe("POST /api/findings/[id]/remediate — field name fix", () => {
  it("passes finding.fileLocation (not filePath) to the AI flow", async () => {
    await POST(makeRequest("finding-1"), { params: Promise.resolve({ id: "finding-1" }) });

    expect(generatePatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "src/db.ts",
      }),
    );
  });

  it("selects only columns that exist on Finding", async () => {
    // Prisma rejects an unknown select key at runtime, before the query runs.
    await POST(makeRequest("finding-1"), { params: Promise.resolve({ id: "finding-1" }) });

    const { select } = mockFindFirst.mock.calls[0][0];
    for (const key of Object.keys(select)) {
      expect(FINDING_COLUMNS).toContain(key);
    }
  });

  it("passes the code snippet and the stored explanation to the AI flow", async () => {
    await POST(makeRequest("finding-1"), { params: Promise.resolve({ id: "finding-1" }) });

    expect(generatePatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        vulnerableCode: FINDING.codeSnippet,
        findingDescription: FINDING.explanation,
      }),
    );
  });

  it("falls back to the remediation text, then the finding type, like the bulk route", async () => {
    mockFindFirst.mockResolvedValueOnce({ ...FINDING, explanation: null });
    await POST(makeRequest("finding-1"), { params: Promise.resolve({ id: "finding-1" }) });
    expect(generatePatchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ findingDescription: FINDING.remediation }),
    );

    mockFindFirst.mockResolvedValueOnce({ ...FINDING, explanation: null, remediation: null });
    await POST(makeRequest("finding-1"), { params: Promise.resolve({ id: "finding-1" }) });
    expect(generatePatchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ findingDescription: "VULNERABILITY vulnerability" }),
    );
  });

  it("uses empty string for codeSnippet when null", async () => {
    mockFindFirst.mockResolvedValue({ ...FINDING, codeSnippet: null });

    await POST(makeRequest("finding-1"), { params: Promise.resolve({ id: "finding-1" }) });

    expect(generatePatchMock).toHaveBeenCalledWith(expect.objectContaining({ vulnerableCode: "" }));
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("POST /api/findings/[id]/remediate — happy path", () => {
  it("upserts the patch with the AI result", async () => {
    await POST(makeRequest("finding-1"), { params: Promise.resolve({ id: "finding-1" }) });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { findingId: "finding-1" },
        update: expect.objectContaining({ status: "GENERATED" }),
        create: expect.objectContaining({ findingId: "finding-1", status: "GENERATED" }),
      }),
    );
  });

  it("returns success:true with patch and explanation", async () => {
    const response = await POST(makeRequest("finding-1"), {
      params: Promise.resolve({ id: "finding-1" }),
    });

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.patch).toEqual(PATCH);
    expect(body.explanation).toBe("Use parameterized queries.");
  });
});
