/**
 * Directory Hotspot View Logic & Service (#2018)
 *
 * Provides functions to group open findings by top-level directory (configurable depth)
 * per repository, with counts by severity, simple trends, and links to the Findings table.
 */

import prisma from "@/lib/prisma";
import { getUserTriage } from "@/lib/triage/queries";
import { readCachedHotspots, writeCachedHotspots } from "./hotspots-cache";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HotspotSeverityCounts {
  CRITICAL: number;
  HIGH: number;
  MEDIUM: number;
  LOW: number;
  INFO: number;
}

export interface HotspotTrend {
  direction: "up" | "down" | "flat";
  change: number; // positive = increase in findings, negative = decrease
  percentage: number;
}

export interface DirectoryHotspot {
  directory: string;
  pathPrefix: string;
  openCount: number;
  severityCounts: HotspotSeverityCounts;
  trend: HotspotTrend;
}

export interface RepoHotspotGroup {
  repositoryId: string;
  repositoryFullName: string;
  totalOpenFindings: number;
  hotspotsByDepth: Record<number, DirectoryHotspot[]>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalizes a file location and extracts directory prefix for given depth.
 * Depth 1: "src" (prefix: "src/")
 * Depth 2: "src/lib" (prefix: "src/lib/")
 * Files in root: "(root)" (prefix: "(root)")
 */
export function extractDirectoryPrefix(
  fileLocation: string | null | undefined,
  depth: number = 1,
): { displayPath: string; filterPrefix: string } {
  if (!fileLocation || typeof fileLocation !== "string") {
    return { displayPath: "(root)", filterPrefix: "(root)" };
  }

  // Normalize Windows-style backslashes and trim leading slashes
  const normalized = fileLocation.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!normalized) {
    return { displayPath: "(root)", filterPrefix: "(root)" };
  }

  const parts = normalized.split("/");
  if (parts.length <= 1) {
    // File is in root directory
    return { displayPath: "(root)", filterPrefix: "(root)" };
  }

  // File is in a subdirectory
  const effectiveDepth = Math.max(1, depth);
  const dirParts = parts.slice(0, Math.min(effectiveDepth, parts.length - 1));
  const dirPath = dirParts.join("/");

  return {
    displayPath: dirPath,
    filterPrefix: `${dirPath}/`,
  };
}

/**
 * Computes trend comparing findings created in the last 14 days vs findings created 15-30 days ago.
 */
export function computeDirectoryTrend(findingDates: Date[], now: Date = new Date()): HotspotTrend {
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  const cutoffRecent = now.getTime() - fourteenDaysMs;
  const cutoffPrior = now.getTime() - thirtyDaysMs;

  let recentCount = 0;
  let priorCount = 0;

  for (const date of findingDates) {
    const time = date.getTime();
    if (time >= cutoffRecent && time <= now.getTime()) {
      recentCount++;
    } else if (time >= cutoffPrior && time < cutoffRecent) {
      priorCount++;
    }
  }

  const change = recentCount - priorCount;
  let direction: "up" | "down" | "flat" = "flat";
  if (change > 0) direction = "up";
  else if (change < 0) direction = "down";

  let percentage = 0;
  if (priorCount === 0) {
    percentage = recentCount > 0 ? 100 : 0;
  } else {
    percentage = Math.round((Math.abs(change) / priorCount) * 100);
  }

  return { direction, change, percentage };
}

export interface RawFindingForHotspot {
  fileLocation: string;
  severity: string;
  createdAt: Date;
}

/**
 * Groups a repository's findings for a specific depth into DirectoryHotspot list.
 */
export function groupFindingsByDirectory(
  findings: RawFindingForHotspot[],
  depth: number,
  now: Date = new Date(),
): DirectoryHotspot[] {
  const groups = new Map<
    string,
    {
      displayPath: string;
      filterPrefix: string;
      openCount: number;
      severityCounts: HotspotSeverityCounts;
      dates: Date[];
    }
  >();

  for (const finding of findings) {
    const { displayPath, filterPrefix } = extractDirectoryPrefix(finding.fileLocation, depth);
    let entry = groups.get(filterPrefix);
    if (!entry) {
      entry = {
        displayPath,
        filterPrefix,
        openCount: 0,
        severityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
        dates: [],
      };
      groups.set(filterPrefix, entry);
    }

    entry.openCount++;
    entry.dates.push(finding.createdAt);

    const sev = finding.severity.toUpperCase();
    if (sev === "CRITICAL") entry.severityCounts.CRITICAL++;
    else if (sev === "HIGH") entry.severityCounts.HIGH++;
    else if (sev === "MEDIUM") entry.severityCounts.MEDIUM++;
    else if (sev === "LOW") entry.severityCounts.LOW++;
    else entry.severityCounts.INFO++;
  }

  const hotspots: DirectoryHotspot[] = [];
  for (const entry of groups.values()) {
    hotspots.push({
      directory: entry.displayPath,
      pathPrefix: entry.filterPrefix,
      openCount: entry.openCount,
      severityCounts: entry.severityCounts,
      trend: computeDirectoryTrend(entry.dates, now),
    });
  }

  // Sort primarily by openCount descending, then critical, then high, then alphabetical
  hotspots.sort((a, b) => {
    if (b.openCount !== a.openCount) return b.openCount - a.openCount;
    if (b.severityCounts.CRITICAL !== a.severityCounts.CRITICAL) {
      return b.severityCounts.CRITICAL - a.severityCounts.CRITICAL;
    }
    if (b.severityCounts.HIGH !== a.severityCounts.HIGH) {
      return b.severityCounts.HIGH - a.severityCounts.HIGH;
    }
    return a.directory.localeCompare(b.directory);
  });

  return hotspots;
}

// ─── Main Service ─────────────────────────────────────────────────────────────

export async function fetchDirectoryHotspots(
  userId: string,
  options?: { forceRefresh?: boolean; depths?: number[] },
): Promise<RepoHotspotGroup[]> {
  if (!options?.forceRefresh) {
    const cached = readCachedHotspots(userId);
    if (cached) return cached;
  }

  const targetDepths = options?.depths ?? [1, 2, 3];

  // 1. Fetch repositories accessible to the user
  const repos = await prisma.repository.findMany({
    where: { userId, isActive: true },
    select: {
      id: true,
      fullName: true,
    },
    orderBy: { fullName: "asc" },
  });

  if (repos.length === 0) {
    writeCachedHotspots(userId, []);
    return [];
  }

  const repoIds = repos.map((r: { id: string }) => r.id);

  // 2. Fetch triage states to filter out resolved/dismissed fingerprints
  const { suppressedFingerprints } = await getUserTriage(userId);
  const suppressedSet = new Set(suppressedFingerprints);

  // 3. Query all open findings for these repositories (indexed by scanResult.pullRequest.repositoryId & fileLocation)
  const findings = await prisma.finding.findMany({
    where: {
      scanResult: {
        pullRequest: { repositoryId: { in: repoIds } },
      },
      suppressionStatus: null,
      NOT: {
        fingerprint: { in: suppressedFingerprints.length > 0 ? suppressedFingerprints : [""] },
      },
    },
    select: {
      fileLocation: true,
      severity: true,
      createdAt: true,
      scanResult: {
        select: {
          pullRequest: {
            select: { repositoryId: true },
          },
        },
      },
    },
  });

  // Group findings by repository
  const findingsByRepo = new Map<string, RawFindingForHotspot[]>();
  for (const repoId of repoIds) {
    findingsByRepo.set(repoId, []);
  }

  for (const f of findings) {
    const repoId = f.scanResult?.pullRequest?.repositoryId;
    if (repoId && findingsByRepo.has(repoId)) {
      findingsByRepo.get(repoId)!.push({
        fileLocation: f.fileLocation,
        severity: f.severity,
        createdAt: f.createdAt,
      });
    }
  }

  const now = new Date();
  const repoHotspotGroups: RepoHotspotGroup[] = [];

  for (const repo of repos) {
    const repoFindings = findingsByRepo.get(repo.id) || [];
    const hotspotsByDepth: Record<number, DirectoryHotspot[]> = {};

    for (const depth of targetDepths) {
      hotspotsByDepth[depth] = groupFindingsByDirectory(repoFindings, depth, now);
    }

    repoHotspotGroups.push({
      repositoryId: repo.id,
      repositoryFullName: repo.fullName,
      totalOpenFindings: repoFindings.length,
      hotspotsByDepth,
    });
  }

  writeCachedHotspots(userId, repoHotspotGroups);
  return repoHotspotGroups;
}
