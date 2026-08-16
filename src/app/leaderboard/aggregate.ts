import "server-only";
import { unstable_cache } from "next/cache";
import prisma from "@/lib/prisma";
import { assignRanks } from "./scoring";
import type { ContributorRow } from "./leaderboard-client";

const ghAvatar = (login: string) => `https://github.com/${login}.png?size=80`;
const LEADERBOARD_REVALIDATE_SECONDS = 60;

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

  const [totals, merged, avatars, users] = await Promise.all([
    prisma.pullRequest.groupBy({ by: ["authorLogin"], where: authored, _count: { _all: true } }),
    prisma.pullRequest.groupBy({ by: ["authorLogin"], where: { ...authored, state: "merged" }, _count: { _all: true } }),
    prisma.pullRequest.findMany({ where: { ...authored, authorAvatarUrl: { not: null } }, select: { authorLogin: true, authorAvatarUrl: true }, distinct: ["authorLogin"] }),
    prisma.user.findMany({
      where: { codename: { not: null } },
      select: { githubLogin: true, name: true, email: true, codename: true },
    }),
  ]);

  const mergedByLogin = new Map(merged.map((row: any) => [row.authorLogin, row._count._all]));
  const avatarByLogin = new Map(avatars.map((row: any) => [row.authorLogin, row.authorAvatarUrl]));
  const codenameByLogin = new Map<string, string>();

  for (const u of users as any[]) {
    if (!u.codename) continue;
    if (u.githubLogin) {
      codenameByLogin.set(u.githubLogin.toLowerCase(), u.codename);
    }
    if (u.name) {
      const normalizedName = u.name.toLowerCase();
      if (!codenameByLogin.has(normalizedName)) {
        codenameByLogin.set(normalizedName, u.codename);
      }
    }
    if (u.email) {
      const emailPrefix = u.email.split("@")[0].toLowerCase();
      if (!codenameByLogin.has(emailPrefix)) {
        codenameByLogin.set(emailPrefix, u.codename);
      }
    }
  }

  return totals.map((row: any) => {
    const login = row.authorLogin as string;
    const mergedCount = mergedByLogin.get(login) ?? 0;
    const codename = codenameByLogin.get(login.toLowerCase()) ?? generateCodename(login);
    return {
      id: login, login, codename,
      avatarUrl: avatarByLogin.get(login) ?? ghAvatar(login),
      htmlUrl: `https://github.com/${login}`,
      score: mergedCount, prCount: row._count._all, mergedCount,
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
