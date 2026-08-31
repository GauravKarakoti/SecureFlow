/**
 * Reading the body of `POST /api/repositories/sync`, and shaping its reply (#749).
 *
 * The route had two branches. The one taken whenever the body contained a
 * `repositoryId` did not synchronise anything:
 *
 * ```ts
 * const mockFilesFound = Array.from({ length: 4500 }, (_, i) => ({
 *   path: `packages/module-core/src/file_${i}.ts`, size: 1024, depth: 4,
 * }));
 * …
 * await Promise.all(batch.map(async () => { totalSyncedFiles++; }));
 * …
 * return NextResponse.json({ success: true, status: "COMPLETED",
 *                            synchronizedFilesCount: totalSyncedFiles, … });
 * ```
 *
 * The comment above that loop read "Execute atomic database writes or tracking
 * registry injections for this batch"; the body of the loop was `++`. `depth`
 * was the literal `4` on every element against a `MAX_DIRECTORY_DEPTH` of `5`,
 * so the filter removed nothing and the count was always exactly 4500.
 * `repositoryId` was destructured and then used only in a log line.
 *
 * Three things followed. It reported `success: true, status: "COMPLETED"` for
 * work that did not happen, so a repository that had never been synchronised
 * looked synchronised. It shadowed the real `syncUserRepositories` call below
 * it, which is unreachable for any request that names a repository — the
 * natural thing for a caller wanting to sync one repository to send. And
 * `repositoryId` was never validated or ownership-checked, which was harmless
 * only because nothing was read, and was a trap for whoever wired real work in.
 *
 * The parsing and the response shape live here so both are covered directly;
 * the route keeps the session, the rate limits and the redaction it already had.
 */

/** The columns the response reports back for a named repository. */
export interface SyncedRepository {
  id: string;
  fullName: string;
  owner: string;
  isActive: boolean;
}

/** The Prisma surface the route uses to resolve a named repository. */
export interface RepositoryLookupStore {
  findFirst: (args: {
    where: { id: string; userId: string };
    select: { id: true; fullName: true; owner: true; isActive: true };
  }) => Promise<SyncedRepository | null>;
}

export type SyncTarget =
  | { ok: true; repositoryId: string | null }
  | { ok: false; message: string };

/**
 * Which repository, if any, this request is about.
 *
 * An absent body or an absent `repositoryId` means "sync everything", which is
 * what the dashboard button sends and what the route did before the fabricated
 * branch was added.
 *
 * A `repositoryId` that is present but not a non-empty string is an error
 * rather than a silent fall-through to the full sync. The old branch was
 * entered on truthiness alone, so `{"repositoryId": ""}` skipped it and
 * `{"repositoryId": 0}` did too, while `{"repositoryId": {}}` took it and
 * returned a fabricated success — three different behaviours for three ways of
 * getting the same field wrong.
 */
export function parseSyncTarget(body: unknown): SyncTarget {
  if (body === null || body === undefined) return { ok: true, repositoryId: null };

  if (typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'Request body must be a JSON object' };
  }

  const raw = (body as Record<string, unknown>).repositoryId;

  if (raw === undefined || raw === null) return { ok: true, repositoryId: null };

  if (typeof raw !== 'string') {
    return { ok: false, message: '`repositoryId` must be a string' };
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, message: '`repositoryId` must not be empty' };
  }

  return { ok: true, repositoryId: trimmed };
}

/** What `syncUserRepositories` reports, as much of it as the response needs. */
export interface SyncOutcome {
  synced: number;
  hasInstallation: boolean;
  skipped?: number;
  failed?: number;
  error?: string;
}

export interface SingleRepositorySyncResponse {
  success: boolean;
  status: 'COMPLETED' | 'NO_INSTALLATION' | 'FAILED';
  repository: SyncedRepository;
  /** Repositories the run actually wrote, across the whole installation. */
  synced: number;
  skipped: number;
  failed: number;
  hasInstallation: boolean;
  error?: string;
}

/**
 * The reply for a request that named one repository.
 *
 * `status` is derived from what the run reported rather than hardcoded to
 * `"COMPLETED"`. That is the substance of this change: a caller has to be able
 * to tell a sync that ran from one that could not, and the previous branch gave
 * the same `success: true, status: "COMPLETED"` to every input it was handed.
 *
 * `repository` carries the row as it stands *after* the run, so the caller sees
 * the refreshed name and active flag rather than a count of imaginary files.
 */
export function singleRepositorySyncResponse(
  repository: SyncedRepository,
  outcome: SyncOutcome
): SingleRepositorySyncResponse {
  const status: SingleRepositorySyncResponse['status'] = outcome.error
    ? 'FAILED'
    : outcome.hasInstallation
      ? 'COMPLETED'
      : 'NO_INSTALLATION';

  return {
    success: status === 'COMPLETED',
    status,
    repository,
    synced: outcome.synced,
    skipped: outcome.skipped ?? 0,
    failed: outcome.failed ?? 0,
    hasInstallation: outcome.hasInstallation,
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}
