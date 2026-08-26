/**
 * Ownership rules for repository synchronisation (#657).
 *
 * `Repository.githubId` is globally unique but `Repository.userId` names a
 * single owner, so an upsert keyed on `githubId` that writes `userId` in its
 * update branch hands the row — and every `PullRequest`, `ScanResult`,
 * `Finding` and `FindingTriage` scoped to it — to whoever synced most recently.
 * Two members of the same GitHub organisation both see the same installation,
 * so this needed nothing unusual to trigger.
 *
 * These helpers decide which repositories a caller may claim before anything is
 * written. They are pure so the decision can be tested without a database.
 */

/** The fields of a GitHub API repository object that the sync actually reads. */
export interface GithubRepoSummary {
  id?: number | string | null;
  full_name?: string | null;
  owner?: { login?: string | null } | null;
}

/** A repository normalised into the shape the `Repository` table stores. */
export interface NormalizedRepo {
  githubId: bigint;
  fullName: string;
  owner: string;
}

/** One `(githubId, userId)` pair already in the database. */
export interface OwnershipRow {
  githubId: bigint;
  userId: string;
}

/**
 * Convert one API repository into a row shape, or `null` when it is unusable.
 *
 * The previous code did `BigInt(repo.id)` unguarded, which throws a
 * `SyntaxError` on a missing or non-numeric id — inside a `Promise.all`, so it
 * took the whole batch down with it.
 *
 * The owner falls back to the part of `full_name` before the slash, matching
 * what the original did, because `owner.login` is occasionally absent on
 * installation-scoped responses.
 */
export function normalizeRepo(repo: GithubRepoSummary | null | undefined): NormalizedRepo | null {
  if (!repo) return null;

  const fullName = typeof repo.full_name === 'string' ? repo.full_name.trim() : '';
  if (!fullName || !fullName.includes('/')) return null;

  let githubId: bigint;
  try {
    if (repo.id === null || repo.id === undefined || repo.id === '') return null;
    githubId = BigInt(repo.id);
  } catch {
    return null;
  }

  const owner = repo.owner?.login?.trim() || fullName.split('/')[0];
  if (!owner) return null;

  return { githubId, fullName, owner };
}

/** Normalise a page of repositories, dropping the ones that cannot be stored. */
export function normalizeRepos(repos: Array<GithubRepoSummary | null | undefined>): {
  usable: NormalizedRepo[];
  malformed: number;
} {
  const usable: NormalizedRepo[] = [];
  let malformed = 0;

  for (const repo of repos) {
    const normalized = normalizeRepo(repo);
    if (normalized) usable.push(normalized);
    else malformed += 1;
  }

  return { usable, malformed };
}

export interface RepoPartition {
  /** Unowned, or already owned by this user — safe to upsert. */
  claimable: NormalizedRepo[];
  /** Already owned by a different user — left alone. */
  foreign: NormalizedRepo[];
}

/**
 * Split a page of repositories by whether this user may write to them.
 *
 * A repository the caller already owns stays claimable so its `fullName` and
 * `owner` keep tracking GitHub across renames. One owned by somebody else is
 * reported rather than taken, so the UI can explain why a repository the user
 * can see on GitHub is not in their dashboard — previously it silently changed
 * hands and the previous owner's findings, code snippets and triage notes went
 * with it.
 */
export function partitionByOwnership(
  repos: NormalizedRepo[],
  existing: OwnershipRow[],
  userId: string
): RepoPartition {
  // Keyed by string: two `bigint`s of equal value are not the same Map key
  // unless they are compared by value, which `Map` does not do for objects but
  // does do for primitives — `bigint` is a primitive, so this is defensive
  // against a caller passing numbers instead.
  const ownerByRepo = new Map<string, string>();
  for (const row of existing) {
    ownerByRepo.set(String(row.githubId), row.userId);
  }

  const claimable: NormalizedRepo[] = [];
  const foreign: NormalizedRepo[] = [];

  for (const repo of repos) {
    const currentOwner = ownerByRepo.get(String(repo.githubId));

    if (currentOwner === undefined || currentOwner === userId) {
      claimable.push(repo);
    } else {
      foreign.push(repo);
    }
  }

  return { claimable, foreign };
}

/**
 * How many repository writes may be in flight at once.
 *
 * `Promise.all(repositories.map(upsert))` fired one query per repository
 * simultaneously; an installation with several hundred repositories emptied the
 * connection pool in a single burst. It also rejects on the first failure while
 * the rest keep running, so a partial sync left no record of how far it got.
 */
export const REPO_SYNC_CONCURRENCY = 10;

/** Split `items` into consecutive groups of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new RangeError('chunk size must be at least 1');

  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Bounded `AuditLog.resource` for a sync.
 *
 * It used to be `repositories.map(r => r.full_name).join(", ")`. `resource` is
 * a single `String` column that every other caller uses as an identifier
 * (`user:<id>`, `<fullName>:<fingerprint>`), so an installation with several
 * hundred repositories wrote a multi-kilobyte comma-joined string into it — and
 * made the row useless for the `resource: { contains: search }` filter on
 * `/admin/logs`. The count was already in `metadata.count` directly below.
 */
export function syncAuditResource(count: number, installationId: number | null): string {
  const scope = installationId === null ? 'unknown' : String(installationId);
  return `installation:${scope}:${count}`;
}

/** How many repository names a sync audit entry carries. */
export const REPO_AUDIT_SAMPLE_SIZE = 25;

/**
 * A bounded sample of repository names for the audit metadata.
 *
 * `sanitizeAuditMetadata` applies its own size limits, but sending it a
 * thousand-element array to be truncated is work nobody needs done.
 */
export function auditRepositorySample(repos: NormalizedRepo[]): string[] {
  return repos.slice(0, REPO_AUDIT_SAMPLE_SIZE).map((r) => r.fullName);
}
