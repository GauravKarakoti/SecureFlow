import "server-only";
import { unstable_cache } from "next/cache";
import prisma from "@/lib/prisma";
import { SUPPRESSED_STATUSES } from "@/lib/triage/statuses";
import {
  assignRanks,
  computeContributorBadges,
  computeContributorScore,
  computeForm,
  type ContributorMetrics,
  type SeverityCounts,
} from "./scoring";
import type { ContributorRow } from "./leaderboard-client";

const ghAvatar = (login: string) => `https://github.com/${login}.png?size=80`;
const LEADERBOARD_REVALIDATE_SECONDS = 60;

/**
 * The pull request status the worker writes for a clean scan
 * (`ArmorIQPolicyEngine.evaluateFindings`). It is the only status that counts
 * toward an author's pass rate.
 */
const PASSED_STATUS = "PASS";

/**
 * Triage statuses that take a finding out of enforcement.
 *
 * This was a local copy of `SUPPRESSED_STATUSES`, kept so the leaderboard's
 * cached path would not pull the triage query helpers — and their Prisma calls
 * — in behind it. The reason was good; the duplication was the wrong answer to
 * it. `@/lib/triage/statuses` holds the list and nothing else (#689).
 */
const SUPPRESSED_TRIAGE_STATUSES = SUPPRESSED_STATUSES;

/**
 * How many recent pull requests to read when computing per-author form.
 *
 * `computeForm` only ever looks at an author's five most recent PRs, so this is
 * a global cap on the scan rather than a per-author limit. An author whose
 * recent PRs all fall outside this window shows a shorter form string; the
 * score itself is unaffected, because it is derived from the complete `groupBy`
 * aggregates rather than from this sample.
 */
const FORM_SCAN_LIMIT = 2000;

const CITIES = [
  "Tokyo", "Denver", "Helsinki", "Nairobi", "Berlin",
  "Rio", "Moscow", "Oslo", "Bogota", "Palermo",
  "Stockholm", "Lisbon", "Marseille", "Reykjavik", "Valencia",
];

function generateCodename(login: string): string {
  let hash = 0;
  for (let i = 0; i < login.length; i++) hash = (hash * 31 + login.charCodeAt(i)) | 0;
  return CITIES[Math.abs(hash) % CITIES.length];
}

function emptyCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

/**
 * Map a stored `Finding.severity` onto a `SeverityCounts` key.
 *
 * The column is an unconstrained `String`, so the comparison is done on the
 * trimmed, upper-cased value rather than by exact match. `NONE` and anything
 * unrecognised are deliberately not counted: they carry no penalty in
 * `computeContributorScore`, and inventing a bucket for them would inflate
 * every author's penalty on data we cannot actually rank.
 */
function severityBucket(severity: string | null | undefined): keyof SeverityCounts | null {
  switch (String(severity ?? "").trim().toUpperCase()) {
    case "CRITICAL": return "critical";
    case "HIGH": return "high";
    case "MEDIUM": return "medium";
    case "LOW": return "low";
    default: return null;
  }
}

/**
 * Aggregate contributor standings in the database instead of streaming every
 * PR row into app memory.
 *
 * Every query is bounded by the number of distinct authors or the number of
 * scans — never by the total finding count — and leans on the `authorLogin`,
 * `[pullRequestId, createdAt desc]` and `fingerprint` indexes:
 *
 *  - one `groupBy` for total PRs per author
 *  - one `groupBy` (state = "MERGED") for the extraction count
 *  - one `groupBy` (status = "PASS") for the pass rate
 *  - one `distinct` lookup for avatars (`groupBy` can't select non-key columns)
 *  - one lookup for user codenames
 *  - one `distinct` lookup for the newest `ScanResult` per pull request
 *  - one lookup for suppressed triage fingerprints
 *  - one lookup of findings belonging to those newest scans
 *  - one capped scan of recent PR statuses for the form string
 *
 * Only the newest scan of each pull request contributes findings. Without that,
 * a PR that was re-scanned five times would count its vulnerabilities five
 * times against its author.
 */
async function aggregateContributors(): Promise<Omit<ContributorRow, "rank">[]> {
  const authored = { authorLogin: { not: null } } as const;

  const [totals, merged, passed, avatars, users, latestScans, suppressed, recentPrs] =
    await Promise.all([
      prisma.pullRequest.groupBy({ by: ["authorLogin"], where: authored, _count: { _all: true } }),
      prisma.pullRequest.groupBy({ by: ["authorLogin"], where: { ...authored, state: "MERGED" }, _count: { _all: true } }),
      prisma.pullRequest.groupBy({ by: ["authorLogin"], where: { ...authored, status: PASSED_STATUS }, _count: { _all: true } }),
      prisma.pullRequest.findMany({ where: { ...authored, authorAvatarUrl: { not: null } }, select: { authorLogin: true, authorAvatarUrl: true }, distinct: ["authorLogin"] }),
      prisma.user.findMany({
        where: { codename: { not: null } },
        select: { githubLogin: true, name: true, email: true, codename: true },
      }),
      // `distinct` keeps the first row per `pullRequestId` after ordering, so the
      // `createdAt desc` secondary sort makes this "the newest scan per PR".
      prisma.scanResult.findMany({
        where: { pullRequest: authored },
        select: { id: true, pullRequest: { select: { authorLogin: true } } },
        orderBy: [{ pullRequestId: "asc" }, { createdAt: "desc" }],
        distinct: ["pullRequestId"],
      }),
      prisma.findingTriage.findMany({
        where: { status: { in: [...SUPPRESSED_TRIAGE_STATUSES] } },
        select: { fingerprint: true },
      }),
      prisma.pullRequest.findMany({
        where: authored,
        select: { authorLogin: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: FORM_SCAN_LIMIT,
      }),
    ]);

  const mergedByLogin = new Map<string, number>(
    merged.map((row: any) => [row.authorLogin as string, row._count._all as number])
  );
  const passedByLogin = new Map<string, number>(
    passed.map((row: any) => [row.authorLogin as string, row._count._all as number])
  );
  const avatarByLogin = new Map<string, string>(
    avatars.map((row: any) => [row.authorLogin as string, row.authorAvatarUrl as string])
  );
  const codenameByLogin = new Map<string, string>();

  for (const u of users as any[]) {
    if (!u.codename) continue;

    const registerAlias = (val: string | null | undefined) => {
      if (!val) return;
      const raw = val.trim().toLowerCase();
      if (!raw) return;

      if (!codenameByLogin.has(raw)) {
        codenameByLogin.set(raw, u.codename);
      }

      // Stripped alphanumeric alias (e.g. "Gaurav Karakoti" -> "gauravkarakoti")
      const alphanumeric = raw.replace(/[^a-z0-9]/g, "");
      if (alphanumeric && !codenameByLogin.has(alphanumeric)) {
        codenameByLogin.set(alphanumeric, u.codename);
      }
    };

    if (u.githubLogin) {
      registerAlias(u.githubLogin);
    }
    if (u.name) {
      registerAlias(u.name);
    }
    if (u.email) {
      const emailPrefix = u.email.split("@")[0];
      registerAlias(emailPrefix);
    }
  }


  // scanResultId -> the author whose pull request that scan belongs to.
  const authorByScanId = new Map<string, string>();
  for (const scan of latestScans as Array<{ id: string; pullRequest: { authorLogin: string | null } | null }>) {
    const login = scan.pullRequest?.authorLogin;
    if (login) authorByScanId.set(scan.id, login);
  }

  // A finding's fingerprint already incorporates its repositoryId (see
  // `computeFingerprint`), so a flat set is correct here — there is no
  // cross-repository collision to guard against.
  const suppressedFingerprints = new Set(suppressed.map((t: any) => t.fingerprint as string));

  const vulnsByLogin = new Map<string, SeverityCounts>();

  if (authorByScanId.size > 0) {
    const findings = await prisma.finding.findMany({
      where: {
        scanResultId: { in: [...authorByScanId.keys()] },
        ...(suppressedFingerprints.size > 0
          ? { fingerprint: { notIn: [...suppressedFingerprints] } }
          : {}),
      },
      select: { scanResultId: true, severity: true },
    });

    for (const finding of findings as Array<{ scanResultId: string; severity: string | null }>) {
      const login = authorByScanId.get(finding.scanResultId);
      if (!login) continue;

      const bucket = severityBucket(finding.severity);
      if (!bucket) continue;

      const counts = vulnsByLogin.get(login) ?? emptyCounts();
      counts[bucket] += 1;
      vulnsByLogin.set(login, counts);
    }
  }

  // Recent pull requests per author, newest first, for the W/D/L form string.
  const prsByLogin = new Map<string, { status: string; createdAt: Date }[]>();
  for (const pr of recentPrs as Array<{ authorLogin: string | null; status: string; createdAt: Date }>) {
    if (!pr.authorLogin) continue;
    const list = prsByLogin.get(pr.authorLogin) ?? [];
    // `computeForm` re-sorts and slices to five anyway; capping here keeps the
    // arrays small for an author with hundreds of PRs inside the scan window.
    if (list.length < 5) {
      list.push({ status: pr.status, createdAt: pr.createdAt });
      prsByLogin.set(pr.authorLogin, list);
    }
  }

  const rows: Omit<ContributorRow, "rank">[] = totals.map((row: any) => {
    const login = row.authorLogin as string;
    const totalPRs = row._count._all as number;
    const mergedCount = mergedByLogin.get(login) ?? 0;
    const passedPRs = passedByLogin.get(login) ?? 0;
    const vulnsIntroduced = vulnsByLogin.get(login) ?? emptyCounts();
    const codename = codenameByLogin.get(login.toLowerCase()) ?? generateCodename(login);

    const metrics: ContributorMetrics = {
      totalPRs,
      mergedPRs: mergedCount,
      passedPRs,
      vulnsIntroduced,
    };

    return {
      id: login,
      login,
      codename,
      avatarUrl: avatarByLogin.get(login) ?? ghAvatar(login),
      htmlUrl: `https://github.com/${login}`,
      // The security score, not the merged-PR count. A contributor who merges a
      // lot of vulnerable code now ranks below one who merges less clean code.
      score: computeContributorScore(metrics),
      prCount: totalPRs,
      mergedCount,
      passedCount: passedPRs,
      findings: vulnsIntroduced,
      badges: computeContributorBadges(metrics),
      form: computeForm(prsByLogin.get(login) ?? []),
    };
  });

  // Deterministic tiebreak before ranking. Scores are bounded integers, so ties
  // are common; `assignRanks` sorts by score alone and `Array.prototype.sort` is
  // stable, so pre-sorting here decides the order within a tie rather than
  // leaving it to whatever order the database happened to return rows in.
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      b.mergedCount - a.mergedCount ||
      a.login.localeCompare(b.login)
  );

  return rows;
}

const cachedContributors = unstable_cache(aggregateContributors, ["leaderboard-contributors"], {
  revalidate: LEADERBOARD_REVALIDATE_SECONDS,
  tags: ["leaderboard"],
});

/** All contributors, ranked by security score (highest first). */
export async function loadContributors(): Promise<Omit<ContributorRow, "rank">[]> {
  return cachedContributors();
}

/** Ranked, top-N contributors ready for the client. */
export async function loadLeaderboard(topN: number): Promise<ContributorRow[]> {
  const rows = await loadContributors();
  return assignRanks(rows).slice(0, topN);
}

/** Pure helpers exposed for unit tests; not part of the module's public API. */
export const __testing = { severityBucket, generateCodename, emptyCounts, FORM_SCAN_LIMIT };
