"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { getUserTriage, triageKey } from "@/lib/triage/queries";
import {
  buildFindingsOrderBy,
  buildFindingsWhere,
  normalizeFindingsQuery,
  planSeverityPage,
  requiresSeverityPlan,
  resolvePage,
  totalPagesFor,
  type FindingStatus,
  type FindingsQuery,
} from "@/lib/findings/query";

/**
 * Server actions for the Security Findings dashboard (#561).
 *
 * Thin on purpose: everything decidable without a database lives in
 * `src/lib/findings/query.ts` and is unit tested there. A `"use server"` module
 * may only export async functions, so the pure helpers could not live here even
 * if we wanted them to.
 *
 * Shapes mirror `src/lib/actions/audit.ts`, which already solved pagination and
 * filtering for the audit log.
 */

async function requireUser(): Promise<string> {
  const session = await auth();

  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  return session.user.id;
}

export interface FindingRow {
  id: string;
  type: string;
  severity: string;
  fileLocation: string;
  lineStart: number | null;
  lineEnd: number | null;
  codeSnippet: string | null;
  explanation: string | null;
  remediation: string | null;
  promptInjectionSuspected: boolean;
  fingerprint: string;
  createdAt: Date;
  repositoryId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  triageStatus: FindingStatus;
  triageNote: string | null;
}

export interface FindingsStats {
  criticalSecrets: number;
  vulnerabilities: number;
  misconfigs: number;
  /** Everything outside the three named buckets, so the tiles always sum. */
  other: number;
}

export interface UserFindingsResult {
  findings: FindingRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface FindingFilterOptions {
  severities: string[];
  types: string[];
  repositories: Array<{ id: string; fullName: string }>;
}

/** Types counted by each stat tile. Unchanged from the previous inline query. */
/**
 * The tile buckets.
 *
 * `Finding.type` is a Prisma enum (`FindingType`), so these are the exact
 * values the column can hold and an exact match is correct. This branch was cut
 * before that migration and carried free-text lists ("Hardcoded Secret",
 * "Logic Flaw", ...) inherited from when the column was an unconstrained
 * String; against the enum those match nothing at all and every tile would read
 * zero. Kept aligned with `page.tsx` on main, which counts the same way.
 *
 * `OTHER` is the complement rather than a list, so the four tiles always sum to
 * the number of findings even if a new member is added to the enum.
 */
const SECRET_TYPES = ["SECRET"];
const VULNERABILITY_TYPES = ["VULNERABILITY"];
const MISCONFIG_TYPES = ["MISCONFIG"];
const CATEGORISED_TYPES = [...SECRET_TYPES, ...VULNERABILITY_TYPES, ...MISCONFIG_TYPES];

/**
 * Group triaged fingerprints by status so the status filter can resolve to a
 * fingerprint set. Triage keys off the fingerprint, not `Finding.id`, so this
 * cannot be a relational include.
 */
function groupFingerprintsByStatus(
  byKey: Map<string, { status: string; note: string | null }>
): Partial<Record<FindingStatus, string[]>> {
  const grouped: Partial<Record<FindingStatus, string[]>> = {};

  for (const [key, entry] of byKey) {
    const fingerprint = key.slice(key.indexOf(":") + 1);
    const status = entry.status as FindingStatus;
    (grouped[status] ??= []).push(fingerprint);
  }

  return grouped;
}

/**
 * One page of findings, plus the stat tiles for the same filter.
 *
 * The tiles and the list are counted from the same `buildFindingsWhere` call so
 * they cannot disagree — previously the tiles applied the dismissal filter and
 * the list did not, which is what made a fully-triaged repository show
 * `0 / 0 / 0` above fifty dismissed rows.
 */
export async function getUserFindings(
  query: FindingsQuery = {}
): Promise<UserFindingsResult & { stats: FindingsStats }> {
  const userId = await requireUser();
  const normalized = normalizeFindingsQuery(query);

  const { suppressedFingerprints, byKey } = await getUserTriage(userId);
  const context = {
    userId,
    dismissedFingerprints: suppressedFingerprints,
    fingerprintsByStatus: groupFingerprintsByStatus(byKey),
  };

  const listWhere = buildFindingsWhere(context, normalized);
  const statWhere = buildFindingsWhere(context, normalized, { includeDismissed: false });

  const [total, criticalSecrets, vulnerabilities, misconfigs, other] = await Promise.all([
    prisma.finding.count({ where: listWhere }),
    prisma.finding.count({
      where: { ...statWhere, type: { in: SECRET_TYPES }, severity: "CRITICAL" },
    }),
    prisma.finding.count({ where: { ...statWhere, type: { in: VULNERABILITY_TYPES } } }),
    prisma.finding.count({ where: { ...statWhere, type: { in: MISCONFIG_TYPES } } }),
    prisma.finding.count({ where: { ...statWhere, type: { notIn: CATEGORISED_TYPES } } }),
  ]);

  const page = resolvePage(normalized.page, total, normalized.pageSize);

  const include = {
    scanResult: {
      include: {
        pullRequest: {
          include: { repository: { select: { id: true, fullName: true } } },
        },
      },
    },
  } as const;

  let rows: any[];

  if (requiresSeverityPlan(normalized.sort)) {
    // `Finding.severity` is a String column, so `orderBy: { severity: 'asc' }`
    // sorts alphabetically and puts LOW above MEDIUM. Severity has five values,
    // so the page is planned as a bounded walk over the buckets instead — see
    // planSeverityPage. Each slice is an ordinary indexed skip/take, and at most
    // five of them can span one page.
    const grouped = await prisma.finding.groupBy({
      by: ["severity"],
      where: listWhere,
      _count: { _all: true },
    });

    const counts: Record<string, number> = {};
    for (const row of grouped as Array<{ severity: string; _count: { _all: number } }>) {
      counts[row.severity.toUpperCase()] = row._count._all;
    }

    const slices = planSeverityPage(counts, page, normalized.pageSize);

    const buckets = await Promise.all(
      slices.map((slice) =>
        prisma.finding.findMany({
          where: { ...listWhere, severity: slice.severity },
          orderBy: [{ createdAt: "desc" }],
          skip: slice.skip,
          take: slice.take,
          include,
        })
      )
    );

    rows = buckets.flat();
  } else {
    rows = await prisma.finding.findMany({
      where: listWhere,
      orderBy: buildFindingsOrderBy(normalized.sort),
      skip: (page - 1) * normalized.pageSize,
      take: normalized.pageSize,
      include,
    });
  }

  const findings: FindingRow[] = rows.map((finding: any) => {
    const pullRequest = finding.scanResult.pullRequest;
    const repositoryId = pullRequest.repositoryId;
    const triage = byKey.get(triageKey(repositoryId, finding.fingerprint));

    return {
      id: finding.id,
      type: finding.type,
      severity: finding.severity,
      fileLocation: finding.fileLocation,
      lineStart: finding.lineStart ?? null,
      lineEnd: finding.lineEnd ?? null,
      codeSnippet: finding.codeSnippet ?? null,
      explanation: finding.explanation ?? null,
      remediation: finding.remediation ?? null,
      promptInjectionSuspected: Boolean(finding.promptInjectionSuspected),
      fingerprint: finding.fingerprint,
      createdAt: finding.createdAt,
      repositoryId,
      repositoryFullName: pullRequest.repository?.fullName ?? "",
      pullRequestNumber: pullRequest.prNumber,
      triageStatus: (triage?.status as FindingStatus) ?? "OPEN",
      triageNote: triage?.note ?? null,
    };
  });

  return {
    findings,
    total,
    page,
    pageSize: normalized.pageSize,
    totalPages: totalPagesFor(total, normalized.pageSize),
    stats: { criticalSecrets, vulnerabilities, misconfigs, other },
  };
}

/**
 * The severities, types and repositories actually present in this user's data.
 *
 * Built from the data rather than from a static list so the dropdowns never
 * offer a filter that would return nothing — the same reasoning as
 * `getUserAuditLogFilters`.
 */
export async function getUserFindingFilters(): Promise<FindingFilterOptions> {
  const userId = await requireUser();
  const ownedByUser = {
    scanResult: { pullRequest: { repository: { userId } } },
  };

  const [severityRows, typeRows, repositories] = await Promise.all([
    prisma.finding.findMany({
      where: ownedByUser,
      distinct: ["severity"],
      select: { severity: true },
    }),
    prisma.finding.findMany({
      where: ownedByUser,
      distinct: ["type"],
      select: { type: true },
      orderBy: { type: "asc" },
    }),
    prisma.repository.findMany({
      where: { userId },
      select: { id: true, fullName: true },
      orderBy: { fullName: "asc" },
    }),
  ]);

  return {
    severities: severityRows.map((row: { severity: string }) => row.severity),
    types: typeRows.map((row: { type: string }) => row.type),
    repositories: repositories.map((repo: { id: string; fullName: string }) => ({
      id: repo.id,
      fullName: repo.fullName,
    })),
  };
}
