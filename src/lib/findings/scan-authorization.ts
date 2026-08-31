/**
 * Who may enqueue a scan, and against what (#748).
 *
 * `POST /api/findings` and `GET /api/findings/status/[jobId]` shipped without
 * an `auth()` call. `src/proxy.ts` only guards `/admin` and `/api/admin`, so
 * nothing upstream covered them either — the sole control on the POST was a
 * 10/minute rate limit, which bounds how often an anonymous caller can do this
 * and not whether they may.
 *
 * The fields that decide what the scan touches all came from the request body:
 *
 *  - `repositoryFullName` and `prNumber` are handed to
 *    `octokit.rest.checks.create` and `octokit.rest.issues.createComment`, so an
 *    unauthenticated request could make SecureFlow's GitHub App post a check run
 *    and a comment on any pull request in any repository the app is installed
 *    on;
 *  - `repositoryId` selected which repository's `FindingTriage` rows were read
 *    and which repository the `ScanResult` was attached to;
 *  - `userId` was optional, unchecked, and used for exactly one thing —
 *    the `AuditLog` row's actor. An audit log a stranger can write arbitrary
 *    attributions into is not an audit log.
 *
 * The shape of the fix is the one `src/lib/actions/triage.ts` already uses: the
 * caller names a repository id, the repository is loaded scoped to the session
 * user, and everything else is read off the row that comes back rather than off
 * the request. A caller can only ever direct the scanner at a repository the
 * lookup already proved they own.
 *
 * The Prisma surfaces are narrowed to interfaces so the decisions can be tested
 * without a database.
 */

import { z } from 'zod';
import type { ScanJobData } from '@/lib/queue/scanQueue';

/** The columns the scan needs from the repository it was authorised against. */
export interface OwnedRepository {
  id: string;
  fullName: string;
}

/** The Prisma surface `loadOwnedRepository` uses. */
export interface RepositoryStore {
  findFirst: (args: {
    where: { id: string; userId: string };
    select: { id: true; fullName: true };
  }) => Promise<OwnedRepository | null>;
}

/**
 * The repository, if this user owns it.
 *
 * Scoped in the `where` rather than fetched and then compared, so a repository
 * belonging to someone else is indistinguishable from one that does not exist —
 * the same query shape as `setFindingStatus`.
 */
export async function loadOwnedRepository(
  store: RepositoryStore,
  repositoryId: string,
  userId: string
): Promise<OwnedRepository | null> {
  if (!repositoryId || !userId) return null;

  return store.findFirst({
    where: { id: repositoryId, userId },
    select: { id: true, fullName: true },
  });
}

/**
 * The accepted body of a scan request.
 *
 * Two fields are gone from the previous schema and their absence is the point:
 *
 *  - `userId`, because the actor is the session, never a request field;
 *  - `repositoryFullName`, because it is `Repository.fullName` and taking it
 *    from the body is what let a caller aim the GitHub App somewhere else.
 *
 * `installationId` is still accepted — `Repository` carries no installation id
 * to derive it from — but it can no longer be used to reach another account's
 * repositories, because the repository name it is combined with now comes from
 * a row the caller was proven to own. An installation id that does not cover
 * that repository simply produces a 404 from GitHub.
 */
export const scanRequestSchema = z.object({
  repositoryId: z.string().min(1),
  installationId: z.union([z.number(), z.string()]),
  prNumber: z.number().int().positive(),
  headSha: z.string().min(1),
  fileChanges: z
    .array(
      z.object({
        filename: z.string(),
        patch: z.string(),
      })
    )
    .default([]),
  activePolicies: z
    .array(z.object({ description: z.string() }).passthrough())
    .default([]),
  customIgnores: z.array(z.string()).default([]),
  customPlaceholders: z.array(z.string()).default([]),
});

export type ScanRequestBody = z.infer<typeof scanRequestSchema>;

/**
 * Assemble the queue payload from the request and the authorised repository.
 *
 * `repositoryId`, `repositoryFullName` and `userId` are taken from the
 * authorisation result, never from `body` — the parameter order here is the
 * safeguard, since `body` cannot supply any of the three.
 */
export function buildScanJobData(args: {
  body: ScanRequestBody;
  repository: OwnedRepository;
  userId: string;
}): ScanJobData {
  const { body, repository, userId } = args;

  return {
    // Replaced by `enqueueScan`, which creates the row this refers to.
    scanJobId: '',
    repositoryId: repository.id,
    repositoryFullName: repository.fullName,
    installationId: body.installationId,
    prNumber: body.prNumber,
    headSha: body.headSha,
    fileChanges: body.fileChanges,
    activePolicies: body.activePolicies,
    customIgnores: body.customIgnores,
    customPlaceholders: body.customPlaceholders,
    userId,
  };
}

/** A scan job row, joined to the owner of its repository. */
export interface ScanJobOwnership {
  repositoryId: string | null;
  repository: { userId: string } | null;
}

/** The Prisma surface `scanJobVisibility` is fed from. */
export interface ScanJobOwnershipStore {
  findUnique: (args: {
    where: { id: string };
    select: { repositoryId: true; repository: { select: { userId: true } } };
  }) => Promise<ScanJobOwnership | null>;
}

/**
 * Whether this user may see this scan job.
 *
 * A job the caller does not own is reported as absent rather than forbidden.
 * Distinguishing the two turns the endpoint into an oracle for "does this job
 * id exist", which is most of what an id-guessing attack wants; and the caller
 * has no legitimate use for the difference.
 *
 * A job with no repository — the column is nullable, and rows predating the
 * ownership check can have it null — has no owner to compare against, so it is
 * not visible to anyone.
 */
export function scanJobVisibility(
  job: ScanJobOwnership | null | undefined,
  userId: string
): 'visible' | 'not-found' {
  if (!job) return 'not-found';
  if (!job.repositoryId || !job.repository) return 'not-found';

  return job.repository.userId === userId ? 'visible' : 'not-found';
}

/**
 * Load the ownership facts for a scan job.
 *
 * Selects only the owner's id: the status payload itself is fetched separately
 * by `getScanJobStatus`, and this query exists purely to decide whether that
 * fetch should happen at all.
 */
export async function loadScanJobOwnership(
  store: ScanJobOwnershipStore,
  scanJobId: string
): Promise<ScanJobOwnership | null> {
  if (!scanJobId) return null;

  return store.findUnique({
    where: { id: scanJobId },
    select: { repositoryId: true, repository: { select: { userId: true } } },
  });
}
