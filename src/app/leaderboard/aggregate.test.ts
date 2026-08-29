import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `unstable_cache` is a passthrough here so each test observes a fresh
 * aggregation rather than a memoised one from a previous case.
 */
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: any[]) => any) => fn,
}));

vi.mock("server-only", () => ({}));

const db = {
  pullRequest: { groupBy: vi.fn(), findMany: vi.fn() },
  user: { findMany: vi.fn() },
  scanResult: { findMany: vi.fn() },
  findingTriage: { findMany: vi.fn() },
  finding: { findMany: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({ default: db }));

const { loadContributors, loadLeaderboard, __testing } = await import("./aggregate");

type Pr = { authorLogin: string | null; status: string; createdAt: Date };

/**
 * Wire the mocked client for one scenario.
 *
 * `pullRequest.groupBy` is called three times with different `where` clauses
 * (all / merged / passed), so the mock dispatches on the clause rather than on
 * call order — the three run inside a single `Promise.all`.
 */
function seed(options: {
  prs: Pr[];
  findings?: Array<{ scanResultId: string; severity: string | null }>;
  scans?: Array<{ id: string; authorLogin: string | null }>;
  suppressed?: string[];
  codenames?: Array<{ githubLogin?: string | null; name?: string | null; email?: string | null; codename: string }>;
}) {
  const { prs, findings = [], scans = [], suppressed = [], codenames = [] } = options;

  const countBy = (rows: Pr[]) => {
    const counts = new Map<string, number>();
    for (const pr of rows) {
      if (!pr.authorLogin) continue;
      counts.set(pr.authorLogin, (counts.get(pr.authorLogin) ?? 0) + 1);
    }
    return [...counts].map(([authorLogin, n]) => ({ authorLogin, _count: { _all: n } }));
  };

  db.pullRequest.groupBy.mockImplementation(async (args: any) => {
    if (args.where?.state === "merged") return countBy(prs.filter((p) => p.status !== "BLOCKED"));
    if (args.where?.status === "PASS") return countBy(prs.filter((p) => p.status === "PASS"));
    return countBy(prs);
  });

  db.pullRequest.findMany.mockImplementation(async (args: any) => {
    // The avatar lookup filters on a non-null avatar; the form scan does not.
    if (args.where?.authorAvatarUrl) return [];
    return prs;
  });

  db.user.findMany.mockResolvedValue(codenames);
  db.scanResult.findMany.mockResolvedValue(
    scans.map((s) => ({ id: s.id, pullRequest: { authorLogin: s.authorLogin } }))
  );
  db.findingTriage.findMany.mockResolvedValue(suppressed.map((fingerprint) => ({ fingerprint })));
  db.finding.findMany.mockResolvedValue(findings);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("severityBucket", () => {
  const { severityBucket } = __testing;

  it("maps the canonical severities", () => {
    expect(severityBucket("CRITICAL")).toBe("critical");
    expect(severityBucket("HIGH")).toBe("high");
    expect(severityBucket("MEDIUM")).toBe("medium");
    expect(severityBucket("LOW")).toBe("low");
  });

  it("tolerates casing and whitespace, since the column is an unconstrained String", () => {
    expect(severityBucket("critical")).toBe("critical");
    expect(severityBucket("  High  ")).toBe("high");
  });

  it("does not bucket NONE or anything unrecognised", () => {
    expect(severityBucket("NONE")).toBeNull();
    expect(severityBucket("nonsense")).toBeNull();
    expect(severityBucket(null)).toBeNull();
    expect(severityBucket(undefined)).toBeNull();
  });
});

describe("generateCodename", () => {
  const { generateCodename } = __testing;

  it("is deterministic for the same login", () => {
    expect(generateCodename("mohit")).toBe(generateCodename("mohit"));
  });

  it("always returns a city name", () => {
    for (const login of ["a", "bb", "ccc", "a-very-long-github-login-here"]) {
      expect(generateCodename(login)).toBeTruthy();
      expect(typeof generateCodename(login)).toBe("string");
    }
  });
});

describe("aggregateContributors", () => {
  const day = (d: number) => new Date(2026, 0, d);

  it("ranks a clean low-volume contributor above a vulnerable high-volume one", async () => {
    seed({
      prs: [
        ...Array.from({ length: 10 }, (_, i) => ({
          authorLogin: "alice",
          status: "BLOCKED",
          createdAt: day(i + 1),
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          authorLogin: "bob",
          status: "PASS",
          createdAt: day(i + 1),
        })),
      ],
      scans: [{ id: "scan-alice", authorLogin: "alice" }],
      findings: Array.from({ length: 12 }, () => ({
        scanResultId: "scan-alice",
        severity: "CRITICAL",
      })),
    });

    const ranked = await loadLeaderboard(10);

    expect(ranked[0].login).toBe("bob");
    expect(ranked[1].login).toBe("alice");
    expect(ranked[0].score).not.toBe(ranked[0].mergedCount);
  });

  it("does not double-count findings when a PR is re-scanned", async () => {
    seed({
      prs: [{ authorLogin: "alice", status: "PASS", createdAt: day(1) }],
      scans: [{ id: "newest", authorLogin: "alice" }],
      findings: [{ scanResultId: "newest", severity: "HIGH" }],
    });

    const rows = await loadContributors();

    expect(db.scanResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ distinct: ["pullRequestId"] })
    );
    expect(rows[0].findings.high).toBe(1);
  });

  it("excludes triaged-away findings from an author's penalty", async () => {
    seed({
      prs: [{ authorLogin: "alice", status: "PASS", createdAt: day(1) }],
      scans: [{ id: "scan-1", authorLogin: "alice" }],
      findings: [],
      suppressed: ["fingerprint-abc"],
    });

    await loadContributors();

    expect(db.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ fingerprint: { notIn: ["fingerprint-abc"] } }),
      })
    );
  });

  it("omits the fingerprint filter entirely when nothing is suppressed", async () => {
    seed({
      prs: [{ authorLogin: "alice", status: "PASS", createdAt: day(1) }],
      scans: [{ id: "scan-1", authorLogin: "alice" }],
    });

    await loadContributors();

    const where = db.finding.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("fingerprint");
  });

  it("tallies severities into the counts the scoring engine expects", async () => {
    seed({
      prs: [{ authorLogin: "alice", status: "PASS", createdAt: day(1) }],
      scans: [{ id: "s", authorLogin: "alice" }],
      findings: [
        { scanResultId: "s", severity: "CRITICAL" },
        { scanResultId: "s", severity: "critical" },
        { scanResultId: "s", severity: "HIGH" },
        { scanResultId: "s", severity: "NONE" },
        { scanResultId: "s", severity: null },
      ],
    });

    const rows = await loadContributors();

    expect(rows[0].findings).toEqual({ critical: 2, high: 1, medium: 0, low: 0 });
  });

  it("attaches badges and recent form, which were never computed before", async () => {
    seed({
      prs: [
        { authorLogin: "bob", status: "PASS", createdAt: day(3) },
        { authorLogin: "bob", status: "REVIEW_REQUIRED", createdAt: day(2) },
        { authorLogin: "bob", status: "BLOCKED", createdAt: day(1) },
      ],
    });

    const rows = await loadContributors();

    expect(rows[0].form).toEqual(["W", "D", "L"]);
    expect(Array.isArray(rows[0].badges)).toBe(true);
  });

  it("caps the form to five entries per author", async () => {
    seed({
      prs: Array.from({ length: 9 }, (_, i) => ({
        authorLogin: "bob",
        status: "PASS",
        createdAt: day(i + 1),
      })),
    });

    const rows = await loadContributors();
    expect(rows[0].form).toHaveLength(5);
  });

  it("prefers a stored codename over the generated one", async () => {
    seed({
      prs: [{ authorLogin: "Alice", status: "PASS", createdAt: day(1) }],
      codenames: [{ githubLogin: "alice", codename: "Delhi" }],
    });

    const rows = await loadContributors();
    expect(rows[0].codename).toBe("Delhi");
  });

  it("uses the user's custom codename from database when matched by name or email prefix (#420)", async () => {
    seed({
      prs: [
        { authorLogin: "delhi_user", status: "PASS", createdAt: day(1) },
        { authorLogin: "gaurav_login", status: "PASS", createdAt: day(1) },
        { authorLogin: "GauravKarakoti", status: "PASS", createdAt: day(1) },
      ],
      codenames: [
        { githubLogin: null, name: "Delhi_User", email: "other@example.com", codename: "Delhi" },
        { githubLogin: null, name: null, email: "gaurav_login@example.com", codename: "Mumbai" },
        { githubLogin: null, name: "Gaurav Karakoti", email: "gk@example.com", codename: "Tokyo" },
      ],
    });

    const rows = await loadContributors();
    const delhiRow = rows.find((r) => r.login === "delhi_user");
    const gauravRow = rows.find((r) => r.login === "gaurav_login");
    const karakotiRow = rows.find((r) => r.login === "GauravKarakoti");

    expect(delhiRow?.codename).toBe("Delhi");
    expect(gauravRow?.codename).toBe("Mumbai");
    expect(karakotiRow?.codename).toBe("Tokyo");
  });

  it("breaks score ties deterministically by merges then login", async () => {
    seed({
      prs: [
        { authorLogin: "zed", status: "PASS", createdAt: day(1) },
        { authorLogin: "amy", status: "PASS", createdAt: day(1) },
      ],
    });

    const rows = await loadContributors();
    expect(rows[0].score).toBe(rows[1].score);
    expect(rows.map((r) => r.login)).toEqual(["amy", "zed"]);
  });

  it("skips the finding query entirely when there are no scans", async () => {
    seed({ prs: [{ authorLogin: "alice", status: "PASS", createdAt: day(1) }], scans: [] });

    const rows = await loadContributors();

    expect(db.finding.findMany).not.toHaveBeenCalled();
    expect(rows[0].findings).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });

  it("returns an empty board when there are no authored pull requests", async () => {
    seed({ prs: [] });
    expect(await loadContributors()).toEqual([]);
    expect(await loadLeaderboard(50)).toEqual([]);
  });

  it("caps the form scan so the query cannot grow with the PR table", async () => {
    seed({ prs: [{ authorLogin: "alice", status: "PASS", createdAt: day(1) }] });

    await loadContributors();

    const formCall = db.pullRequest.findMany.mock.calls.find(
      (call: any[]) => call[0]?.take === __testing.FORM_SCAN_LIMIT
    );
    expect(formCall).toBeDefined();
  });

  it("issues a fixed number of queries regardless of author count — no N+1", async () => {
    seed({
      prs: Array.from({ length: 40 }, (_, i) => ({
        authorLogin: `dev${i}`,
        status: "PASS",
        createdAt: day(1),
      })),
      scans: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, authorLogin: `dev${i}` })),
      findings: [],
    });

    await loadContributors();

    expect(db.pullRequest.groupBy).toHaveBeenCalledTimes(3);
    expect(db.pullRequest.findMany).toHaveBeenCalledTimes(2);
    expect(db.scanResult.findMany).toHaveBeenCalledTimes(1);
    expect(db.finding.findMany).toHaveBeenCalledTimes(1);
    expect(db.findingTriage.findMany).toHaveBeenCalledTimes(1);
    expect(db.user.findMany).toHaveBeenCalledTimes(1);
  });

  it("applies dense ranks and honours the topN slice", async () => {
    seed({
      prs: [
        { authorLogin: "a", status: "PASS", createdAt: day(1) },
        { authorLogin: "b", status: "PASS", createdAt: day(1) },
        { authorLogin: "c", status: "PASS", createdAt: day(1) },
      ],
    });

    const ranked = await loadLeaderboard(2);
    expect(ranked).toHaveLength(2);
    expect(ranked.every((r) => typeof r.rank === "number")).toBe(true);
  });
});

