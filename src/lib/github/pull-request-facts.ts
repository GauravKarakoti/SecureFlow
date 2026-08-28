/**
 * The facts a `pull_request` delivery carries about the pull request itself,
 * as opposed to the findings a scan produces (#702).
 *
 * Two of them were being dropped on the floor by `src/lib/queue/worker.ts`:
 *
 *  1. **Authorship.** `PullRequest.authorLogin` and `authorAvatarUrl` exist in
 *     the schema, `authorLogin` is indexed, and `payloadSchema` in the worker
 *     already validates `pull_request.user.login` and `.avatar_url`. The
 *     `pullRequest.upsert` then wrote neither. Since every query in
 *     `aggregateContributors` is scoped by `{ authorLogin: { not: null } }`,
 *     the contributor leaderboard could only ever return an empty list on a
 *     real deployment — the reported symptom in #696.
 *
 *  2. **The merge.** `normalizePrStateEnum` was fed `pull_request.state`, which
 *     GitHub only ever sets to `"open"` or `"closed"`. It is *never*
 *     `"merged"`; a merge is signalled by the sibling `merged` boolean and the
 *     `merged_at` timestamp. So `PRState.MERGED` was unreachable, and with it
 *     the leaderboard's extraction count, the 15-point `mergedBonus` in
 *     `computeContributorScore`, and the `🔧 Prolific Merger` badge.
 *
 * Everything here is pure and takes a plain object, so the mapping is testable
 * without a queue, a Prisma client or an Octokit instance — which the worker
 * itself is not. Same shape as `src/lib/github/webhook-verification.ts`.
 */

/** The `PRState` members, mirroring `prisma/schema.prisma`. */
export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';

/**
 * What a `pull_request` action is worth doing.
 *
 * - `scan` — new or changed head commit; run the full pipeline.
 * - `metadata` — the code has not changed but the row has. Record the new facts
 *   and stop: there is no new head SHA to analyse, and burning a Groq call plus
 *   a pull request comment on an already-closed PR helps nobody.
 * - `ignore` — nothing to do.
 */
export type PullRequestActionKind = 'scan' | 'metadata' | 'ignore';

/** Actions that justify a full scan. Unchanged from the previous inline list. */
export const SCANNABLE_ACTIONS = ['opened', 'synchronize', 'reopened'] as const;

/**
 * Actions that update the stored row without scanning.
 *
 * `closed` is the important one and the reason this distinction exists: it is
 * the *only* delivery that can tell us a pull request was merged, and the old
 * filter dropped it. Every row therefore stayed `state: OPEN` forever.
 *
 * `edited` is here because a retitled pull request should not keep showing its
 * old title on the dashboard, and updating a row is cheap.
 */
export const METADATA_ONLY_ACTIONS = ['closed', 'edited'] as const;

/** The subset of a `pull_request` payload this module reads. */
export interface PullRequestPayloadLike {
  state?: unknown;
  merged?: unknown;
  merged_at?: unknown;
  title?: unknown;
  number?: unknown;
  user?: { login?: unknown; avatar_url?: unknown } | null;
}

/**
 * Classify a `pull_request` action.
 *
 * Unknown actions — `labeled`, `assigned`, `review_requested` and the other
 * dozen GitHub sends — are ignored rather than scanned, exactly as before.
 */
export function classifyPullRequestAction(action: unknown): PullRequestActionKind {
  if (typeof action !== 'string') return 'ignore';

  const clean = action.trim().toLowerCase();

  if ((SCANNABLE_ACTIONS as readonly string[]).includes(clean)) return 'scan';
  if ((METADATA_ONLY_ACTIONS as readonly string[]).includes(clean)) return 'metadata';

  return 'ignore';
}

/**
 * Whether a payload says the pull request was merged.
 *
 * Both signals are honoured because they can disagree in practice. `merged` is
 * the documented boolean, but it is absent from some third-party and replayed
 * deliveries, whereas `merged_at` is a timestamp that is null until the merge
 * lands. Treating either as sufficient means a delivery that carries only one
 * of them is still recorded correctly, and requiring both would reintroduce the
 * bug this function exists to fix on a narrower set of payloads.
 */
export function isMergedPayload(pullRequest: PullRequestPayloadLike | null | undefined): boolean {
  if (!pullRequest || typeof pullRequest !== 'object') return false;

  if (pullRequest.merged === true) return true;

  const mergedAt = pullRequest.merged_at;
  return typeof mergedAt === 'string' && mergedAt.trim() !== '';
}

/**
 * Resolve the stored state from the whole payload rather than one field.
 *
 * The ordering is the substance: a merged pull request is *also* closed, and
 * GitHub reports it as `state: "closed"`. Checking `merged` first is what makes
 * `MERGED` reachable at all.
 *
 * An unrecognised `state` falls back to `OPEN`, matching the column default and
 * the behaviour of `normalizePrStateEnum`, so a malformed payload cannot mark a
 * live pull request as closed.
 */
export function resolvePullRequestState(
  pullRequest: PullRequestPayloadLike | null | undefined
): PullRequestState {
  if (isMergedPayload(pullRequest)) return 'MERGED';

  const state = pullRequest?.state;
  if (typeof state !== 'string') return 'OPEN';

  const clean = state.trim().toUpperCase();
  if (clean === 'MERGED') return 'MERGED';
  if (clean === 'CLOSED') return 'CLOSED';

  return 'OPEN';
}

/** Trim a payload string, returning null for anything that is not usable. */
function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The author's GitHub login, or null when the payload does not name one. */
export function resolveAuthorLogin(
  pullRequest: PullRequestPayloadLike | null | undefined
): string | null {
  return optionalString(pullRequest?.user?.login);
}

/**
 * The author's avatar URL, or null.
 *
 * Restricted to `https:` because this value is rendered as an `<img src>` on the
 * public leaderboard. `user.avatar_url` is attacker-influenced in the sense that
 * it arrives in a webhook body — the signature proves the body came from GitHub,
 * not that every field in it is a URL we should hand to a browser. The
 * leaderboard already falls back to `https://github.com/<login>.png` when this
 * is null, so rejecting an odd value costs nothing.
 */
export function resolveAuthorAvatarUrl(
  pullRequest: PullRequestPayloadLike | null | undefined
): string | null {
  const raw = optionalString(pullRequest?.user?.avatar_url);
  if (!raw) return null;

  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

/** The title to store, falling back to the PR number when none is given. */
export function resolvePullRequestTitle(
  pullRequest: PullRequestPayloadLike | null | undefined
): string {
  const title = optionalString(pullRequest?.title);
  if (title) return title;

  const number = pullRequest?.number;
  return typeof number === 'number' ? `PR #${number}` : 'Untitled pull request';
}

/** Everything derived from the payload that belongs on the stored row. */
export interface PullRequestFacts {
  title: string;
  state: PullRequestState;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
}

/** Collect the stored-row facts from a `pull_request` payload. */
export function buildPullRequestFacts(
  pullRequest: PullRequestPayloadLike | null | undefined
): PullRequestFacts {
  return {
    title: resolvePullRequestTitle(pullRequest),
    state: resolvePullRequestState(pullRequest),
    authorLogin: resolveAuthorLogin(pullRequest),
    authorAvatarUrl: resolveAuthorAvatarUrl(pullRequest),
  };
}

/**
 * The `data` for a Prisma update, omitting authorship the payload did not carry.
 *
 * A null login is left out rather than written, so a delivery that happens not
 * to name a user cannot erase attribution an earlier delivery established. The
 * inverse — writing a login when the column is already null — is the whole point
 * of putting these fields in `update` and not only in `create`: every row
 * written before this change has `authorLogin = NULL`, and they need the next
 * delivery to backfill them rather than staying invisible to the leaderboard
 * forever.
 */
export function pullRequestUpdateData(facts: PullRequestFacts): {
  title: string;
  state: PullRequestState;
  authorLogin?: string;
  authorAvatarUrl?: string;
} {
  return {
    title: facts.title,
    state: facts.state,
    ...(facts.authorLogin ? { authorLogin: facts.authorLogin } : {}),
    ...(facts.authorAvatarUrl ? { authorAvatarUrl: facts.authorAvatarUrl } : {}),
  };
}
