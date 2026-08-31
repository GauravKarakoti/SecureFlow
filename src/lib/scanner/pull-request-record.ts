/**
 * Finding or creating the `PullRequest` row a queued scan attaches to (#747).
 *
 * `scanEngine.ts` did this inline, against columns that do not exist:
 *
 * ```ts
 * let dbPr = await prisma.pullRequest.findFirst({
 *   where: { repositoryId, number: prNumber },
 * });
 * if (!dbPr) {
 *   dbPr = await prisma.pullRequest.create({
 *     data: { repositoryId, githubId: BigInt(0), number: prNumber,
 *             title: `PR #${prNumber}`, state: 'OPEN', headSha },
 *   });
 * }
 * ```
 *
 * `prisma/schema.prisma` names the column `prNumber`, and `PullRequest` has no
 * `headSha` at all — the head SHA lives on the scan, not on the row. Prisma
 * rejects an unknown argument outright, so both statements threw, and because
 * the engine's whole persistence phase is inside a `catch` that only logs, every
 * queued scan silently stored nothing.
 *
 * `githubId: BigInt(0)` was the third problem. The column is `@unique`, so the
 * literal zero works exactly once per database: the second pull request ever
 * created through this path collides with the first. The real id is available —
 * one `pulls.get` returns it, along with the title and author the leaderboard
 * needs (#702) — so it is fetched rather than faked.
 *
 * The GitHub and Prisma surfaces are narrowed to interfaces here so the
 * resolution can be tested without an installation or a database.
 */

import {
  buildPullRequestFacts,
  pullRequestUpdateData,
  type PullRequestFacts,
  type PullRequestPayloadLike,
} from '@/lib/github/pull-request-facts';

/** The stored row, as much of it as the caller needs. */
export interface PullRequestRow {
  id: string;
}

/** The Prisma surface this module uses. */
export interface PullRequestStore {
  findFirst: (args: {
    where: { repositoryId: string; prNumber: number };
    select: { id: true };
  }) => Promise<PullRequestRow | null>;
  upsert: (args: {
    where: { githubId: bigint };
    update: Record<string, unknown>;
    create: Record<string, unknown>;
    select: { id: true };
  }) => Promise<PullRequestRow>;
}

/** The single GitHub call this module makes. */
export interface PullRequestFetcher {
  (args: { owner: string; repo: string; pull_number: number }): Promise<{
    data: (PullRequestPayloadLike & { id?: unknown }) | null | undefined;
  }>;
}

/**
 * Thrown when GitHub answers without a usable pull request id.
 *
 * `PullRequest.githubId` is a required unique `BigInt`. There is no safe
 * fallback: a placeholder collides with the next pull request that also has no
 * id, which is how `BigInt(0)` behaved. Failing here means the scan reports a
 * persistence error instead of poisoning the table.
 */
export class MissingPullRequestIdError extends Error {
  constructor(repositoryFullName: string, prNumber: number) {
    super(`GitHub returned no id for ${repositoryFullName}#${prNumber}`);
    this.name = 'MissingPullRequestIdError';
  }
}

/**
 * Split `owner/repo`, rejecting anything that is not exactly that.
 *
 * `'a/b/c'.split('/')` yields three parts and the old code destructured the
 * first two, quietly scanning `a/b` instead of failing. An empty half is worse:
 * `''.split('/')` gives `['']`, so `repo` was `undefined` and reached the
 * GitHub client as the string `"undefined"`.
 */
export function splitRepositoryFullName(fullName: string): { owner: string; repo: string } {
  const parts = typeof fullName === 'string' ? fullName.split('/') : [];

  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    throw new Error(`Expected a repository as "owner/repo", received: ${JSON.stringify(fullName)}`);
  }

  return { owner: parts[0].trim(), repo: parts[1].trim() };
}

/**
 * A GitHub pull request id as the `BigInt` column takes it.
 *
 * The REST API returns it as a JSON number, but a job replayed from BullMQ has
 * been through `JSON.parse`, and third-party mirrors of the API send it as a
 * string. Both are accepted; anything else is a missing id.
 */
export function parsePullRequestId(value: unknown): bigint | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? BigInt(value) : null;
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = BigInt(value.trim());
    // `> BigInt(0)` rather than `> 0n`: the literal form needs an ES2020 target
    // and `tsconfig.json` sets ES2017.
    return parsed > BigInt(0) ? parsed : null;
  }

  return null;
}

/**
 * The `create` payload for a `PullRequest` row.
 *
 * `status` is deliberately left to the column default (`REVIEW_REQUIRED`)
 * rather than derived from the scan verdict. The verdict belongs to the
 * `ScanResult` this row is about to receive; writing it onto the pull request
 * as well would mean two sources of truth that drift the moment a re-scan lands
 * a different decision.
 */
export function pullRequestCreateData(args: {
  githubId: bigint;
  prNumber: number;
  repositoryId: string;
  facts: PullRequestFacts;
}): Record<string, unknown> {
  return {
    githubId: args.githubId,
    prNumber: args.prNumber,
    repositoryId: args.repositoryId,
    title: args.facts.title,
    state: args.facts.state,
    authorLogin: args.facts.authorLogin,
    authorAvatarUrl: args.facts.authorAvatarUrl,
  };
}

export interface ResolvePullRequestArgs {
  store: PullRequestStore;
  fetchPullRequest: PullRequestFetcher;
  repositoryId: string;
  repositoryFullName: string;
  prNumber: number;
}

/**
 * The stored row for this pull request, creating it if this is the first scan.
 *
 * The existing-row lookup comes first so the common case — a re-scan of a pull
 * request the webhook worker already recorded — costs one indexed query and no
 * GitHub call. Only a genuinely unknown pull request pays for `pulls.get`.
 *
 * The write is an `upsert` on `githubId` rather than a `create`, because two
 * scans of the same new pull request can be in flight at once: `/api/findings`
 * has no per-pull-request deduplication, and the queue's `attempts: 2` means a
 * retried job repeats this step. A bare `create` loses that race with a unique
 * constraint violation, which the outer `catch` would then swallow.
 */
export async function resolvePullRequestRecord(
  args: ResolvePullRequestArgs
): Promise<PullRequestRow> {
  const { store, fetchPullRequest, repositoryId, repositoryFullName, prNumber } = args;

  const existing = await store.findFirst({
    where: { repositoryId, prNumber },
    select: { id: true },
  });

  if (existing) return existing;

  const { owner, repo } = splitRepositoryFullName(repositoryFullName);
  const response = await fetchPullRequest({ owner, repo, pull_number: prNumber });
  const payload = response?.data ?? null;

  const githubId = parsePullRequestId(payload?.id);
  if (githubId === null) {
    throw new MissingPullRequestIdError(repositoryFullName, prNumber);
  }

  const facts = buildPullRequestFacts({ ...payload, number: prNumber });

  return store.upsert({
    where: { githubId },
    // A row that exists under this `githubId` but was not found by the
    // `(repositoryId, prNumber)` lookup above means the repository row was
    // re-created — its id changed while GitHub's did not. Re-pointing it is
    // right; the facts are refreshed at the same time.
    update: { ...pullRequestUpdateData(facts), repositoryId, prNumber },
    create: pullRequestCreateData({ githubId, prNumber, repositoryId, facts }),
    select: { id: true },
  });
}
