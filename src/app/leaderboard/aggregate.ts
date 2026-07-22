import "server-only";
import { unstable_cache } from "next/cache";
import prisma from "@/lib/prisma";
import { assignRanks } from "./scoring";
import type { ContributorRow } from "./leaderboard-client";

/**
 * Global, auth-free data for the public contribution leaderboard.
 *
 * Every connected repo's pull requests are aggregated by author across the
 * whole platform (no per-user scoping), so anyone — signed in or not — sees the
 * same season standings. Points are stars: a contributor earns one star for
 * every pull request of theirs that gets merged.
 */

const ghAvatar = (login: string) => `https://github.com/${login}.png?size=80`;

// The leaderboard is global and public, so the underlying aggregation is
// identical for every visitor. We cache it rather than re-querying per request.
// (The page itself stays dynamic because the shared nav renders a per-user
// login button via `auth()`, so route-segment `revalidate` can't apply here —
// caching the data layer is the equivalent, and cheaper, fix.)
const LEADERBOARD_REVALIDATE_SECONDS = 60;

/**
 * Aggregate contributor standings in the database instead of streaming every
 * PR row into app memory.
 *
 * - one `groupBy` for total PRs per author,
 * - one `groupBy` (state = "merged") for the star/merged count,
 * - one `distinct` lookup for avatars (`groupBy` can't select non-key columns).
 *
 * All three are bounded by the number of distinct authors, not the total PR
 * count, and lean on the `authorLogin` index.
 */
async function aggregateContributors(): Promise<Omit<ContributorRow, "rank">[]> {
  const authored = { authorLogin: { not: null } } as const;

  const [totals, merged, avatars] = await Promise.all([
    prisma.pullRequest.groupBy({
      by: ["authorLogin"],
      where: authored,
      _count: { _all: true },
    }),
    prisma.pullRequest.groupBy({
      by: ["authorLogin"],
      where: { ...authored, state: "merged" },
      _count: { _all: true },
    }),
    prisma.pullRequest.findMany({
      where: { ...authored, authorAvatarUrl: { not: null } },
      select: { authorLogin: true, authorAvatarUrl: true },
      distinct: ["authorLogin"],
    }),
  ]);

  const mergedByLogin = new Map(merged.map((row: any) => [row.authorLogin, row._count._all]));
  const avatarByLogin = new Map(avatars.map((row: any) => [row.authorLogin, row.authorAvatarUrl]));

  return totals.map((row: any) => {
    const login = row.authorLogin as string; // non-null: filtered above
    const mergedCount = mergedByLogin.get(login) ?? 0;
    return {
      id: login,
      login,
      avatarUrl: avatarByLogin.get(login) ?? ghAvatar(login),
      htmlUrl: `https://github.com/${login}`,
      score: mergedCount, // 1 star = 1 merged PR
      prCount: row._count._all,
      mergedCount,
    };
  });
}

const cachedContributors = unstable_cache(aggregateContributors, ["leaderboard-contributors"], {
  revalidate: LEADERBOARD_REVALIDATE_SECONDS,
  tags: ["leaderboard"],
});

/** All contributors, ranked by merged-PR stars (highest first). */
export async function loadContributors(): Promise<Omit<ContributorRow, "rank">[]> {
  return cachedContributors();
}

/** Ranked, top-N contributors ready for the client. */
export async function loadLeaderboard(topN: number): Promise<ContributorRow[]> {
  const rows = await loadContributors();
  return assignRanks(rows).slice(0, topN);
}
