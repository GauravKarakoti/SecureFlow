import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server actions behind /dashboard/findings (#561).
 *
 * The query arithmetic is covered in `src/lib/findings/query.test.ts`; these
 * tests pin what the actions do with it: every read is scoped to the signed-in
 * user, the tiles and the list share one filter, a severity sort is read as
 * per-bucket slices, and triage decisions are joined back onto the rows.
 */

let session: { user: { id: string } } | null = { user: { id: "user-1" } };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => session),
}));

const prismaMock = vi.hoisted(() => ({
  finding: { count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  repository: { findMany: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ default: prismaMock }));

const mockGetUserTriage = vi.hoisted(() => vi.fn());

vi.mock("@/lib/triage/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/triage/queries")>()),
  getUserTriage: mockGetUserTriage,
}));

import { getUserFindingFilters, getUserFindings } from "./findings";

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: "SECRET",
    severity: "HIGH",
    fileLocation: "src/app.ts",
    lineStart: 3,
    lineEnd: undefined,
    codeSnippet: "const key = ...",
    explanation: null,
    remediation: undefined,
    promptInjectionSuspected: 0,
    fingerprint: `fp-${id}`,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    scanResult: {
      pullRequest: {
        repositoryId: "repo-1",
        prNumber: 12,
        repository: { id: "repo-1", fullName: "org/api" },
      },
    },
    ...overrides,
  };
}

function triage(entries: Array<[string, string, string, string | null]> = []) {
  const byKey = new Map<string, { status: string; note: string | null }>();
  for (const [repositoryId, fingerprint, status, note] of entries) {
    byKey.set(`${repositoryId}:${fingerprint}`, { status, note });
  }
  const suppressed = entries
    .filter(([, , status]) => status === "FALSE_POSITIVE" || status === "IGNORED")
    .map(([, fingerprint]) => fingerprint);
  return { suppressedFingerprints: suppressed, byKey, truncated: false };
}

/** Five counts in call order: list total, then the four tiles. */
function stubCounts(total: number, tiles: [number, number, number, number] = [1, 2, 3, 4]) {
  prismaMock.finding.count.mockResolvedValueOnce(total);
  for (const value of tiles) prismaMock.finding.count.mockResolvedValueOnce(value);
}

beforeEach(() => {
  session = { user: { id: "user-1" } };
  vi.clearAllMocks();
  prismaMock.finding.count.mockReset();
  prismaMock.finding.findMany.mockReset();
  prismaMock.finding.groupBy.mockReset();
  prismaMock.repository.findMany.mockReset();
  mockGetUserTriage.mockResolvedValue(triage());
});

describe("getUserFindings", () => {
  it("rejects a caller without a session", async () => {
    session = null;

    await expect(getUserFindings()).rejects.toThrow("Unauthorized");
    expect(prismaMock.finding.count).not.toHaveBeenCalled();
  });

  it("maps rows, fills optional fields with null and joins triage by repository and fingerprint", async () => {
    mockGetUserTriage.mockResolvedValue(triage([["repo-1", "fp-a", "IN_PROGRESS", "on it"]]));
    stubCounts(2);
    prismaMock.finding.findMany.mockResolvedValue([row("a"), row("b")]);

    const result = await getUserFindings();

    expect(result.findings[0]).toEqual({
      id: "a",
      type: "SECRET",
      severity: "HIGH",
      fileLocation: "src/app.ts",
      lineStart: 3,
      lineEnd: null,
      codeSnippet: "const key = ...",
      explanation: null,
      remediation: null,
      promptInjectionSuspected: false,
      fingerprint: "fp-a",
      createdAt: new Date("2026-09-01T00:00:00Z"),
      repositoryId: "repo-1",
      repositoryFullName: "org/api",
      pullRequestNumber: 12,
      triageStatus: "IN_PROGRESS",
      triageNote: "on it",
    });
    expect(result.findings[1]).toMatchObject({ triageStatus: "OPEN", triageNote: null });
  });

  it("returns the tiles, the page and the page count", async () => {
    stubCounts(45, [2, 5, 1, 7]);
    prismaMock.finding.findMany.mockResolvedValue([]);

    const result = await getUserFindings({ page: 2, pageSize: 20 });

    expect(result).toMatchObject({
      total: 45,
      page: 2,
      pageSize: 20,
      totalPages: 3,
      stats: { criticalSecrets: 2, vulnerabilities: 5, misconfigs: 1, other: 7 },
    });
    expect(prismaMock.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 20, orderBy: [{ createdAt: "desc" }] }),
    );
  });

  it("scopes every count to the user and splits the tiles by type", async () => {
    stubCounts(0);
    prismaMock.finding.findMany.mockResolvedValue([]);

    await getUserFindings();

    const wheres = prismaMock.finding.count.mock.calls.map(([args]) => args.where);
    for (const where of wheres) {
      expect(where.scanResult).toEqual({ pullRequest: { repository: { userId: "user-1" } } });
    }
    expect(wheres[1]).toMatchObject({ type: { in: ["SECRET"] }, severity: "CRITICAL" });
    expect(wheres[2]).toMatchObject({ type: { in: ["VULNERABILITY"] } });
    expect(wheres[3]).toMatchObject({ type: { in: ["MISCONFIG"] } });
    expect(wheres[4]).toMatchObject({
      type: { notIn: ["SECRET", "VULNERABILITY", "MISCONFIG"] },
    });
  });

  it("keeps dismissed findings out of the tiles even when the list asks for them", async () => {
    mockGetUserTriage.mockResolvedValue(triage([["repo-1", "fp-gone", "FALSE_POSITIVE", null]]));
    stubCounts(1);
    prismaMock.finding.findMany.mockResolvedValue([]);

    await getUserFindings({ status: ["FALSE_POSITIVE"] });

    const [listWhere, ...tileWheres] = prismaMock.finding.count.mock.calls.map(
      ([args]) => args.where,
    );
    expect(listWhere.fingerprint).not.toEqual({ notIn: ["fp-gone"] });
    for (const where of tileWheres) {
      expect(where.fingerprint).toEqual({ notIn: ["fp-gone"] });
    }
  });

  it("reads a severity sort as per-bucket slices in severity order", async () => {
    stubCounts(5);
    prismaMock.finding.groupBy.mockResolvedValue([
      { severity: "LOW", _count: { _all: 2 } },
      { severity: "CRITICAL", _count: { _all: 1 } },
      { severity: "high", _count: { _all: 2 } },
      { severity: "NOT-A-SEVERITY", _count: { _all: 9 } },
    ]);
    prismaMock.finding.findMany.mockImplementation(async ({ where }) => [
      row(`${where.severity}-row`, { severity: where.severity }),
    ]);

    const result = await getUserFindings({ sort: "severity", pageSize: 10 });

    const slices = prismaMock.finding.findMany.mock.calls.map(([args]) => ({
      severity: args.where.severity,
      skip: args.skip,
      take: args.take,
    }));
    expect(slices).toEqual([
      { severity: "CRITICAL", skip: 0, take: 1 },
      { severity: "HIGH", skip: 0, take: 2 },
      { severity: "LOW", skip: 0, take: 2 },
    ]);
    expect(result.findings.map((f) => f.severity)).toEqual(["CRITICAL", "HIGH", "LOW"]);
  });

  it("falls back to an empty repository name", async () => {
    stubCounts(1);
    const orphan = row("x");
    orphan.scanResult.pullRequest.repository = undefined as never;
    prismaMock.finding.findMany.mockResolvedValue([orphan]);

    const result = await getUserFindings();

    expect(result.findings[0].repositoryFullName).toBe("");
  });
});

describe("getUserFindingFilters", () => {
  it("rejects a caller without a session", async () => {
    session = null;

    await expect(getUserFindingFilters()).rejects.toThrow("Unauthorized");
  });

  it("offers only the severities, types and repositories the user has", async () => {
    prismaMock.finding.findMany
      .mockResolvedValueOnce([{ severity: "HIGH" }, { severity: "LOW" }])
      .mockResolvedValueOnce([{ type: "SECRET" }]);
    prismaMock.repository.findMany.mockResolvedValue([
      { id: "repo-1", fullName: "org/api", extra: "ignored" },
    ]);

    const filters = await getUserFindingFilters();

    expect(filters).toEqual({
      severities: ["HIGH", "LOW"],
      types: ["SECRET"],
      repositories: [{ id: "repo-1", fullName: "org/api" }],
    });
    const owned = { scanResult: { pullRequest: { repository: { userId: "user-1" } } } };
    expect(prismaMock.finding.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: owned, distinct: ["severity"] }),
    );
    expect(prismaMock.finding.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: owned, distinct: ["type"] }),
    );
    expect(prismaMock.repository.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
  });
});
