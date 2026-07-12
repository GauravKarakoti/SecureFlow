import "server-only";
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

/** All contributors, ranked by merged-PR stars (highest first). */
export async function loadContributors(): Promise<Omit<ContributorRow, "rank">[]> {
  const prs = await prisma.pullRequest.findMany({
    select: { state: true, authorLogin: true, authorAvatarUrl: true },
  });

  const map = new Map<string, { total: number; merged: number; avatar: string | null }>();
  for (const pr of prs) {
    const login = pr.authorLogin;
    if (!login) continue;
    const c = map.get(login) ?? { total: 0, merged: 0, avatar: null };
    c.total++;
    if (pr.state === "merged") c.merged++;
    if (!c.avatar && pr.authorAvatarUrl) c.avatar = pr.authorAvatarUrl;
    map.set(login, c);
  }

  return Array.from(map.entries()).map(([login, c]) => ({
    id: login,
    login,
    avatarUrl: c.avatar ?? ghAvatar(login),
    htmlUrl: `https://github.com/${login}`,
    score: c.merged, // 1 star = 1 merged PR
    prCount: c.total,
    mergedCount: c.merged,
  }));
}

/** Ranked, top-N contributors ready for the client. */
export async function loadLeaderboard(topN: number): Promise<ContributorRow[]> {
  const rows = await loadContributors();
  return assignRanks(rows).slice(0, topN);
}
