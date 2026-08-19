/**
 * Paginated retrieval of the files changed by a pull request.
 *
 * `GET /repos/{owner}/{repo}/pulls/{n}/files` is paginated with a default page
 * size of 30. Calling `octokit.rest.pulls.listFiles` without pagination — as the
 * webhook worker previously did — silently returns only the first page, so every
 * file past the 30th was never scanned and never counted toward the policy
 * decision. For a tool that gates merges on security findings, that is a false
 * PASS rather than a cosmetic truncation.
 */

/** GitHub's maximum page size for this endpoint. */
export const PR_FILES_PAGE_SIZE = 100;

/**
 * Ceiling on how many files a single scan will pull.
 *
 * A pull request can legitimately contain thousands of files (a lockfile refresh,
 * a generated-code drop, a vendored dependency bump). Fetching them all would
 * exhaust the installation's API budget and the worker's memory, so the fetch is
 * bounded — but unlike the old behaviour the bound is reported to the caller
 * rather than applied silently.
 *
 * GitHub itself caps this endpoint at 3000 files, so a higher value buys nothing.
 */
export const DEFAULT_MAX_PR_FILES = 300;

export interface PullRequestFile {
  filename: string;
  status?: string;
  patch?: string;
  [key: string]: unknown;
}

export interface PullRequestFilesResult {
  /** The files retrieved, capped at `maxFiles`. */
  files: PullRequestFile[];
  /** How many files were actually retrieved. */
  fetched: number;
  /** True when the PR changed more files than were retrieved. */
  truncated: boolean;
  /**
   * Total files the PR changed, when GitHub told us. Null when the caller did not
   * supply `changedFiles` and pagination stopped at the cap, since in that case we
   * know there are more but not how many more.
   */
  totalChanged: number | null;
}

/** The slice of Octokit this helper needs, kept narrow so it is trivial to fake. */
export interface PullRequestFilesClient {
  paginate: {
    iterator: (
      route: unknown,
      params: Record<string, unknown>
    ) => AsyncIterable<{ data: PullRequestFile[] }>;
  };
  rest: {
    pulls: {
      listFiles: unknown;
    };
  };
}

export interface FetchPullRequestFilesOptions {
  owner: string;
  repo: string;
  pullNumber: number;
  /** Upper bound on files retrieved. Defaults to `DEFAULT_MAX_PR_FILES`. */
  maxFiles?: number;
  /**
   * `pull_request.changed_files` from the webhook payload, when available. Lets
   * the result report an exact total even though the fetch stopped at the cap.
   */
  changedFiles?: number | null;
}

/**
 * Retrieve every file changed by a pull request, up to `maxFiles`.
 *
 * Uses `paginate.iterator` rather than `paginate` so the walk stops as soon as the
 * cap is reached instead of buffering all pages first.
 */
export async function fetchPullRequestFiles(
  octokit: PullRequestFilesClient,
  options: FetchPullRequestFilesOptions
): Promise<PullRequestFilesResult> {
  const { owner, repo, pullNumber } = options;
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_PR_FILES);
  const declaredTotal =
    typeof options.changedFiles === 'number' && options.changedFiles >= 0
      ? options.changedFiles
      : null;

  const files: PullRequestFile[] = [];
  let hitCap = false;

  const pages = octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: PR_FILES_PAGE_SIZE,
  });

  for await (const page of pages) {
    for (const file of page.data ?? []) {
      if (files.length >= maxFiles) {
        hitCap = true;
        break;
      }
      files.push(file);
    }
    if (hitCap) break;
  }

  // Truncation is known either because we stopped at the cap, or because the
  // payload told us the PR changed more files than we hold.
  const truncated = hitCap || (declaredTotal !== null && declaredTotal > files.length);

  return {
    files,
    fetched: files.length,
    truncated,
    totalChanged: declaredTotal ?? (truncated ? null : files.length),
  };
}

/**
 * Human-readable coverage line for the PR comment and the check run output.
 *
 * Returns null when the whole PR was analysed, so callers can omit the line
 * entirely rather than printing a reassurance nobody needs.
 */
export function formatCoverageNotice(result: PullRequestFilesResult): string | null {
  if (!result.truncated) return null;

  const total = result.totalChanged;
  const scope = total === null ? 'the first' : `${result.fetched} of ${total}`;

  return total === null
    ? `⚠️ This pull request changed more files than SecureFlow analyses in a single scan. Only ${scope} ${result.fetched} files were reviewed — findings in the remaining files are **not** reflected below.`
    : `⚠️ Only ${scope} changed files were analysed. Findings in the remaining ${total - result.fetched} file(s) are **not** reflected below.`;
}
