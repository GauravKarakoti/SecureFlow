import { describe, it, expect } from "vitest";
import {
  assignRanks,
  computeBadges,
  computeContributorBadges,
  computeContributorScore,
  computeForm,
  computeSecurityScore,
  formatBounty,
  type ContributorMetrics,
  type RepoMetrics,
  type SeverityCounts,
} from "./scoring";

const noVulns: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };

function contributor(overrides: Partial<ContributorMetrics> = {}): ContributorMetrics {
  return {
    totalPRs: 10,
    mergedPRs: 10,
    passedPRs: 10,
    vulnsIntroduced: { ...noVulns },
    ...overrides,
  };
}

describe("computeContributorScore", () => {
  it("stays within 0-100 for every input it is given", () => {
    const cases: ContributorMetrics[] = [
      contributor(),
      contributor({ totalPRs: 0, mergedPRs: 0, passedPRs: 0 }),
      contributor({ vulnsIntroduced: { critical: 100, high: 100, medium: 100, low: 100 } }),
      contributor({ mergedPRs: 1000 }),
    ];

    for (const metrics of cases) {
      const score = computeContributorScore(metrics);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it("ranks a clean low-volume contributor above a vulnerable high-volume one", () => {
    // This is the case the leaderboard got backwards: `alice` merged more, so
    // she outranked `bob` despite shipping twelve criticals.
    const alice = computeContributorScore(
      contributor({
        totalPRs: 10,
        mergedPRs: 10,
        passedPRs: 0,
        vulnsIntroduced: { critical: 12, high: 0, medium: 0, low: 0 },
      })
    );
    const bob = computeContributorScore(
      contributor({ totalPRs: 4, mergedPRs: 4, passedPRs: 4 })
    );

    expect(bob).toBeGreaterThan(alice);
  });

  it("penalises more severe vulnerabilities more heavily", () => {
    const withCritical = computeContributorScore(
      contributor({ vulnsIntroduced: { ...noVulns, critical: 1 } })
    );
    const withLow = computeContributorScore(
      contributor({ vulnsIntroduced: { ...noVulns, low: 1 } })
    );

    expect(withCritical).toBeLessThan(withLow);
  });

  it("caps the vulnerability penalty, so the score has a floor rather than running negative", () => {
    // The penalty is capped at 60, so a contributor who is otherwise perfect
    // (40 base + 25 pass bonus + 15 merged bonus) bottoms out at 20 rather than
    // at 0. Doubling the vulnerability count past the cap changes nothing.
    const many = computeContributorScore(
      contributor({ vulnsIntroduced: { critical: 50, high: 50, medium: 50, low: 50 } })
    );
    const absurd = computeContributorScore(
      contributor({ vulnsIntroduced: { critical: 5000, high: 5000, medium: 5000, low: 5000 } })
    );

    expect(many).toBe(absurd);
    expect(many).toBeGreaterThanOrEqual(0);
    expect(many).toBeLessThan(computeContributorScore(contributor()));
  });

  it("reaches 0 when the penalty is capped and nothing was merged or passed", () => {
    const score = computeContributorScore({
      totalPRs: 10,
      mergedPRs: 0,
      passedPRs: 0,
      vulnsIntroduced: { critical: 20, high: 0, medium: 0, low: 0 },
    });
    expect(score).toBe(0);
  });

  it("caps the merged bonus so volume alone cannot dominate", () => {
    const eight = computeContributorScore(contributor({ mergedPRs: 8, totalPRs: 8, passedPRs: 8 }));
    const eightHundred = computeContributorScore(
      contributor({ mergedPRs: 800, totalPRs: 800, passedPRs: 800 })
    );
    expect(eightHundred).toBe(eight);
  });

  it("treats a contributor with no PRs as a full pass rate rather than dividing by zero", () => {
    const score = computeContributorScore(contributor({ totalPRs: 0, mergedPRs: 0, passedPRs: 0 }));
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(0);
  });

  it("rewards a higher pass rate", () => {
    const half = computeContributorScore(contributor({ totalPRs: 10, passedPRs: 5, mergedPRs: 0 }));
    const full = computeContributorScore(contributor({ totalPRs: 10, passedPRs: 10, mergedPRs: 0 }));
    expect(full).toBeGreaterThan(half);
  });
});

describe("computeContributorBadges", () => {
  it("awards the clean-record badges to a spotless contributor", () => {
    const labels = computeContributorBadges(contributor()).map((b) => b.label);
    expect(labels).toContain("Zero Vulns Introduced");
    expect(labels).toContain("Clean Record");
    expect(labels).toContain("Prolific Merger");
  });

  it("awards no vulnerability badges to a contributor who shipped criticals", () => {
    const labels = computeContributorBadges(
      contributor({ passedPRs: 0, vulnsIntroduced: { ...noVulns, critical: 3 } })
    ).map((b) => b.label);

    expect(labels).not.toContain("Zero Vulns Introduced");
    expect(labels).not.toContain("Clean Record");
    expect(labels).not.toContain("No Criticals");
  });

  it("awards No Criticals only when there are findings but none critical", () => {
    const withOnlyLows = computeContributorBadges(
      contributor({ vulnsIntroduced: { ...noVulns, low: 2 } })
    ).map((b) => b.label);
    expect(withOnlyLows).toContain("No Criticals");

    const withNothing = computeContributorBadges(contributor()).map((b) => b.label);
    expect(withNothing).not.toContain("No Criticals");
  });

  it("withholds Prolific Merger below five merges", () => {
    const labels = computeContributorBadges(
      contributor({ totalPRs: 4, mergedPRs: 4, passedPRs: 4 })
    ).map((b) => b.label);
    expect(labels).not.toContain("Prolific Merger");
  });

  it("gives a contributor with no PRs at all no participation badges", () => {
    const labels = computeContributorBadges(
      contributor({ totalPRs: 0, mergedPRs: 0, passedPRs: 0 })
    ).map((b) => b.label);
    expect(labels).not.toContain("Zero Vulns Introduced");
    expect(labels).not.toContain("Clean Record");
  });

  it("returns an array, never undefined", () => {
    expect(Array.isArray(computeContributorBadges(contributor()))).toBe(true);
  });
});

describe("computeForm", () => {
  const at = (day: number) => new Date(2026, 0, day);

  it("maps statuses to W / D / L", () => {
    const form = computeForm([
      { status: "PASS", createdAt: at(3) },
      { status: "REVIEW REQUIRED", createdAt: at(2) },
      { status: "BLOCKED", createdAt: at(1) },
    ]);
    expect(form).toEqual(["W", "D", "L"]);
  });

  it("orders newest first regardless of input order", () => {
    const form = computeForm([
      { status: "BLOCKED", createdAt: at(1) },
      { status: "PASS", createdAt: at(5) },
      { status: "REVIEW REQUIRED", createdAt: at(3) },
    ]);
    expect(form).toEqual(["W", "D", "L"]);
  });

  it("returns at most five entries", () => {
    const prs = Array.from({ length: 12 }, (_, i) => ({ status: "PASS", createdAt: at(i + 1) }));
    expect(computeForm(prs)).toHaveLength(5);
  });

  it("does not mutate its input", () => {
    const prs = [
      { status: "BLOCKED", createdAt: at(1) },
      { status: "PASS", createdAt: at(5) },
    ];
    const snapshot = [...prs];
    computeForm(prs);
    expect(prs).toEqual(snapshot);
  });

  it("treats an unknown status as a loss", () => {
    expect(computeForm([{ status: "SOMETHING_ELSE", createdAt: at(1) }])).toEqual(["L"]);
  });

  it("returns an empty array for a contributor with no PRs", () => {
    expect(computeForm([])).toEqual([]);
  });
});

describe("assignRanks", () => {
  it("assigns dense ranks, sharing a rank on a tie", () => {
    const ranked = assignRanks([{ score: 80 }, { score: 100 }, { score: 90 }, { score: 90 }]);
    expect(ranked.map((r) => [r.score, r.rank])).toEqual([
      [100, 1],
      [90, 2],
      [90, 2],
      [80, 3],
    ]);
  });

  it("does not mutate its input", () => {
    const rows = [{ score: 1 }, { score: 2 }];
    const snapshot = [...rows];
    assignRanks(rows);
    expect(rows).toEqual(snapshot);
  });

  it("preserves the incoming order within a tie (stable sort)", () => {
    const ranked = assignRanks([
      { score: 50, login: "a" },
      { score: 50, login: "b" },
      { score: 50, login: "c" },
    ]);
    expect(ranked.map((r) => r.login)).toEqual(["a", "b", "c"]);
  });

  it("handles an empty list", () => {
    expect(assignRanks([])).toEqual([]);
  });
});

describe("formatBounty", () => {
  it("renders thousands", () => {
    expect(formatBounty(4)).toBe("€40K");
  });

  it("renders millions once the score is high enough", () => {
    expect(formatBounty(100)).toBe("€1M");
  });

  it("floors at the minimum bounty rather than showing €0", () => {
    expect(formatBounty(0)).toBe("€10K");
    expect(formatBounty(-5)).toBe("€10K");
  });
});

describe("computeSecurityScore (repository view)", () => {
  const repo = (overrides: Partial<RepoMetrics> = {}): RepoMetrics => ({
    totalPRs: 10,
    passedPRs: 10,
    findings: { ...noVulns },
    daysSinceLastCritical: null,
    ...overrides,
  });

  it("stays within 0-100", () => {
    expect(computeSecurityScore(repo())).toBeLessThanOrEqual(100);
    expect(
      computeSecurityScore(repo({ findings: { critical: 50, high: 50, medium: 50, low: 50 } }))
    ).toBeGreaterThanOrEqual(0);
  });

  it("rewards a longer clean streak", () => {
    const fresh = computeSecurityScore(repo({ daysSinceLastCritical: 1 }));
    const week = computeSecurityScore(repo({ daysSinceLastCritical: 7 }));
    const month = computeSecurityScore(repo({ daysSinceLastCritical: 30 }));

    expect(week).toBeGreaterThan(fresh);
    expect(month).toBeGreaterThan(week);
  });
});

describe("computeBadges (repository view)", () => {
  it("awards Zero Vulnerabilities only when there are none", () => {
    const clean = computeBadges({
      totalPRs: 5,
      passedPRs: 5,
      findings: { ...noVulns },
      daysSinceLastCritical: null,
    }).map((b) => b.label);
    expect(clean).toContain("Zero Vulnerabilities");

    const dirty = computeBadges({
      totalPRs: 5,
      passedPRs: 5,
      findings: { ...noVulns, low: 1 },
      daysSinceLastCritical: null,
    }).map((b) => b.label);
    expect(dirty).not.toContain("Zero Vulnerabilities");
  });
});
