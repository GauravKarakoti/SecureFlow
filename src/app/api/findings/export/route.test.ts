import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { authMock, findingFindMany, getUserTriageMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  findingFindMany: vi.fn(),
  getUserTriageMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));

vi.mock("@/lib/prisma", () => ({
  default: { finding: { findMany: findingFindMany } },
}));

vi.mock("@/lib/triage/queries", () => ({
  getUserTriage: getUserTriageMock,
  triageKey: (repositoryId: string, fingerprint: string) => `${repositoryId}:${fingerprint}`,
}));

vi.mock("@/lib/middleware/rate-limit", () => ({
  TIERS: { ADMIN: { limit: 30, windowSeconds: 60, fallbackStrategy: "fail-closed" } },
  withRateLimit: <T>(handler: T): T => handler,
}));

import {
  FINDINGS_EXPORT_BATCH_SIZE,
  FINDINGS_EXPORT_COLUMNS,
  GET,
  buildExportPageWhere,
  findingsExportFilename,
  searchParamsToRecord,
  toFindingsExportRow,
} from "./route";
import { collectCsvStream } from "@/lib/utils/csv-stream";
import { CSV_BOM } from "@/lib/utils/csv";

const withoutBom = (csv: string) => (csv.startsWith(CSV_BOM) ? csv.slice(CSV_BOM.length) : csv);

function finding(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `f-${String(index).padStart(4, "0")}`,
    type: "SECRET",
    severity: "HIGH",
    fileLocation: `src/file-${index}.ts`,
    lineStart: index,
    lineEnd: null,
    remediation: null,
    fingerprint: `fp-${index}`,
    createdAt: new Date(Date.UTC(2026, 8, 1) - index * 1000),
    scanResult: {
      pullRequest: {
        repositoryId: "repo-1",
        prNumber: 7,
        repository: { id: "repo-1", fullName: "acme/api" },
      },
    },
    ...overrides,
  };
}

function request(query = ""): NextRequest {
  return new NextRequest(`http://localhost:3000/api/findings/export${query}`);
}

/** Serve `rows` in the order the route asks for, honouring `take` like Prisma does. */
function serve(rows: ReturnType<typeof finding>[]) {
  let offset = 0;
  findingFindMany.mockImplementation(async ({ take }: { take: number }) => {
    const page = rows.slice(offset, offset + take);
    offset += page.length;
    return page;
  });
}

describe("searchParamsToRecord", () => {
  it("keeps repeated keys as arrays and single keys as strings", () => {
    expect(
      searchParamsToRecord(new URLSearchParams("severity=HIGH&severity=CRITICAL&q=token")),
    ).toEqual({ severity: ["HIGH", "CRITICAL"], q: "token" });
  });
});

describe("buildExportPageWhere", () => {
  const filter = { scanResult: { pullRequest: { repository: { userId: "u" } } }, OR: [{ a: 1 }] };

  it("returns the filter unchanged for the first page", () => {
    expect(buildExportPageWhere(filter, null)).toBe(filter);
  });

  it("ANDs the cursor with the filter so the filter's own OR survives", () => {
    const createdAt = new Date("2026-09-01T00:00:00Z");
    expect(buildExportPageWhere(filter, { createdAt, id: "f-9" })).toEqual({
      AND: [filter, { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { gt: "f-9" } }] }],
    });
  });
});

describe("toFindingsExportRow", () => {
  it("resolves the triage status by repository and fingerprint, defaulting to OPEN", () => {
    const byKey = new Map([["repo-1:fp-1", { status: "RESOLVED", note: null }]]);

    expect(toFindingsExportRow(finding(1), byKey)).toMatchObject({
      id: "f-0001",
      repository: "acme/api",
      pullRequest: 7,
      status: "RESOLVED",
      lineStart: 1,
      lineEnd: "",
    });
    expect(toFindingsExportRow(finding(2), byKey).status).toBe("OPEN");
  });

  it("produces exactly the export columns", () => {
    expect(Object.keys(toFindingsExportRow(finding(1), new Map()))).toEqual([
      ...FINDINGS_EXPORT_COLUMNS,
    ]);
  });
});

describe("findingsExportFilename", () => {
  it("stamps the date", () => {
    expect(findingsExportFilename(new Date("2026-09-22T10:00:00Z"))).toBe(
      "secureflow-findings-2026-09-22.csv",
    );
  });
});

describe("GET /api/findings/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-123" } });
    getUserTriageMock.mockResolvedValue({
      suppressedFingerprints: [],
      byKey: new Map(),
      truncated: false,
    });
  });

  it("returns 401 without a session", async () => {
    authMock.mockResolvedValue(null);
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(findingFindMany).not.toHaveBeenCalled();
  });

  it("exports every matching finding, not one page of them", async () => {
    // More than a dashboard page (max 100) and more than one database batch.
    const rows = Array.from({ length: FINDINGS_EXPORT_BATCH_SIZE + 120 }, (_, i) => finding(i));
    serve(rows);

    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /attachment; filename="secureflow-findings-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const csv = await collectCsvStream(res.body!);
    const lines = withoutBom(csv).trimEnd().split(/\r?\n/);

    expect(lines[0]).toBe(FINDINGS_EXPORT_COLUMNS.join(","));
    expect(lines).toHaveLength(rows.length + 1);
    expect(findingFindMany).toHaveBeenCalledTimes(2);

    // The second batch seeks from the last row of the first.
    const second = findingFindMany.mock.calls[1][0];
    const lastOfFirst = rows[FINDINGS_EXPORT_BATCH_SIZE - 1];
    expect(second.where.AND[1].OR[1]).toEqual({
      createdAt: lastOfFirst.createdAt,
      id: { gt: lastOfFirst.id },
    });
  });

  it("applies the dashboard's filters and scopes to the session user", async () => {
    serve([finding(1)]);

    // The body is read so the stream actually pulls its first batch.
    await collectCsvStream(
      (await GET(request("?severity=CRITICAL&type=SECRET&repo=repo-1&q=token&page=3&pageSize=100")))
        .body!,
    );

    const { where, orderBy } = findingFindMany.mock.calls[0][0];
    expect(where.scanResult.pullRequest.repository).toEqual({ userId: "user-123", id: "repo-1" });
    expect(where.severity).toEqual({ in: ["CRITICAL"] });
    expect(where.type).toEqual({ in: ["SECRET"] });
    expect(JSON.stringify(where.AND)).toContain('"contains":"token"');
    expect(orderBy).toEqual([{ createdAt: "desc" }, { id: "asc" }]);
  });

  it("leaves dismissed findings out, the way the list does", async () => {
    getUserTriageMock.mockResolvedValue({
      suppressedFingerprints: ["fp-dismissed"],
      byKey: new Map([["repo-1:fp-dismissed", { status: "FALSE_POSITIVE", note: null }]]),
      truncated: false,
    });
    serve([]);

    const csv = await collectCsvStream((await GET(request())).body!);

    expect(findingFindMany.mock.calls[0][0].where.fingerprint).toEqual({
      notIn: ["fp-dismissed"],
    });
    // Header-only rather than an error: "nothing matches" is a valid export.
    expect(withoutBom(csv).trimEnd()).toBe(FINDINGS_EXPORT_COLUMNS.join(","));
  });
});
