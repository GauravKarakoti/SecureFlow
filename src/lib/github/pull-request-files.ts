/**
 * Paginated retrieval of the files changed by a pull request.
 *
 * `GET /repos/{owner}/{repo}/pulls/{n}/files` is paginated with a default page
 * size of 30. Calling `octokit.rest.pulls.listFiles` without pagination — as the
 * webhook worker previously did — silently returns only the first page, so every
 * file past the 30th was never scanned and never counted toward the policy
 * decision. For a tool that gates merges on security findings, that is a false
 * PASS rather than a cosmetic truncation.
 *
 * For large pull requests where GitHub's single PR diff endpoint fails (e.g. 406
 * Not Acceptable or diff too large) or returns truncated diff responses, SecureFlow
 * detects the condition and falls back to per-file pagination (`pulls.listFiles`),
 * recording unpatched files with a reason (#2015).
 */

import { ignoreReasonFor } from "@/lib/armor/ignore-rules";

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

/** GitHub single-diff file limit before GitHub diff endpoint refuses or truncates (#2015). */
export const GITHUB_SINGLE_DIFF_FILE_LIMIT = 300;

export interface PullRequestFile {
  filename: string;
  status?: string;
  patch?: string;
  [key: string]: unknown;
}

export interface UnscannedFileEntry {
  filename: string;
  reason: string;
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
  /** Files without patches (e.g. binary or diff too large), recorded with a reason (#2015). */
  unscannedFiles?: UnscannedFileEntry[];
  /** Whether the fallback to per-file pagination was used (#2015). */
  usedFallback?: boolean;
}

/** The slice of Octokit this helper needs, kept narrow so it is trivial to fake. */
export interface PullRequestFilesClient {
  paginate: {
    iterator: (
      route: unknown,
      params: Record<string, unknown>,
    ) => AsyncIterable<{ data: PullRequestFile[] }>;
  };
  rest: {
    pulls: {
      listFiles: unknown;
      get?: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        mediaType?: { format?: string };
        headers?: Record<string, string>;
      }) => Promise<{ data: unknown; status?: number; headers?: Record<string, unknown> }>;
    };
  };
  request?: (
    route: string,
    params?: Record<string, unknown>,
  ) => Promise<{ data: unknown; status?: number; headers?: Record<string, unknown> }>;
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
  /**
   * Whether to prefer the single-diff endpoint first.
   * If true (or undefined and `pulls.get` is available), attempts single diff.
   * On 406 / diff-too-large / truncated response, falls back to paginated listFiles (#2015).
   */
  preferDiff?: boolean;
}

/**
 * Checks whether an error is a GitHub diff-too-large or 406 Not Acceptable error (#2015).
 */
export function isDiffTooLargeError(error: unknown): boolean {
  if (!error) return false;
  const err = error as Record<string, unknown>;
  if (err.status === 406 || err.statusCode === 406) return true;
  const message = String(err.message ?? err.error ?? err);
  return /diff\s+too\s+large|too\s+large|not\s+acceptable|exceeded\s+diff\s+limit/i.test(message);
}

/**
 * Checks whether GitHub returned a truncated diff response (#2015).
 */
export function isDiffResponseTruncated(response: {
  data?: unknown;
  headers?: Record<string, unknown>;
}): boolean {
  if (!response) return false;
  const headers = response.headers;
  if (headers) {
    if (
      headers["x-github-diff-truncated"] === "true" ||
      headers["x-github-diff-truncated"] === true ||
      headers["x-github-truncated"] === "true" ||
      headers["x-github-truncated"] === true
    ) {
      return true;
    }
  }
  if (typeof response.data === "string") {
    return (
      /diff is too large to show/i.test(response.data) ||
      /diff too large/i.test(response.data) ||
      /\.\.\.\s*diff truncated\s*\.\.\./i.test(response.data) ||
      /warning: diff is too large/i.test(response.data)
    );
  }
  return false;
}

const BINARY_FILE_PATTERN =
  /\.(png|jpe?g|gif|ico|pdf|zip|gz|tar|tgz|bz2|7z|rar|exe|dll|so|dylib|wasm|class|jar|war|pyc|iso|bin|dmg|mp3|mp4|mov|avi|webm|ogg|wav|flac|aac|webp|ttf|woff|woff2|eot|cur|lockb)$/i;

/**
 * Determines the reason a file was not scanned (e.g. binary file or diff too large) (#2015).
 */
export function determineUnscannedReason(file: PullRequestFile): string {
  if (BINARY_FILE_PATTERN.test(file.filename)) {
    return "binary file";
  }
  return "diff too large";
}

/**
 * Returns changed files that have no patch (excluding removed files) with their reason (#2015).
 */
export function getUnscannedFiles(files: readonly PullRequestFile[]): UnscannedFileEntry[] {
  return files
    .filter(
      (file) =>
        file.status !== "removed" && (typeof file.patch !== "string" || file.patch.trim() === ""),
    )
    .map((file) => ({
      filename: file.filename,
      reason: determineUnscannedReason(file),
    }));
}

/**
 * Parses a raw multi-file unified git diff string into PullRequestFile entries (#2015).
 */
export function parseMultiFileUnifiedDiff(rawDiff: string): PullRequestFile[] {
  if (!rawDiff || typeof rawDiff !== "string") return [];

  const files: PullRequestFile[] = [];
  const fileChunks = rawDiff.split(/^diff --git /m);

  for (const chunk of fileChunks) {
    if (!chunk.trim()) continue;

    const fullChunk = "diff --git " + chunk;
    const lines = fullChunk.split("\n");
    const firstLine = lines[0] ?? "";

    const match = firstLine.match(/^diff --git a\/(.*?) b\/(.*)$/);
    let filename = "";
    if (match) {
      filename = match[2];
    } else {
      const headerMatch = fullChunk.match(/^\+\+\+ (?:b\/)?"?(.*?)"?$/m);
      if (headerMatch && headerMatch[1] !== "/dev/null") {
        filename = headerMatch[1];
      } else {
        const deletedMatch = fullChunk.match(/^--- (?:a\/)?"?(.*?)"?$/m);
        if (deletedMatch && deletedMatch[1] !== "/dev/null") {
          filename = deletedMatch[1];
        }
      }
    }

    if (!filename) continue;

    let status = "modified";
    if (/^new file mode /m.test(fullChunk) || /^--- \/dev\/null/m.test(fullChunk)) {
      status = "added";
    } else if (/^deleted file mode /m.test(fullChunk) || /^\+\+\+ \/dev\/null/m.test(fullChunk)) {
      status = "removed";
    }

    const isBinary = /^Binary files /m.test(fullChunk) || /^GIT binary patch/m.test(fullChunk);

    let patch: string | undefined = undefined;
    if (!isBinary) {
      const hunkIdx = fullChunk.search(/\n@@ -\d+/);
      if (hunkIdx !== -1) {
        patch = fullChunk.slice(hunkIdx + 1);
      } else if (/^@@ -\d+/.test(fullChunk)) {
        patch = fullChunk;
      }
    }

    files.push({
      filename,
      status,
      patch,
    });
  }

  return files;
}

/**
 * Retrieve every file changed by a pull request, up to `maxFiles`.
 *
 * For normal-sized PRs, attempts the single diff endpoint if available.
 * If GitHub refuses (406 Not Acceptable / diff too large), returns a truncated diff,
 * or exceeds the single-diff file limit, falls back to paginated `pulls.listFiles`.
 * Files without patches are recorded as unscanned with a reason (#2015).
 */
export async function fetchPullRequestFiles(
  octokit: PullRequestFilesClient,
  options: FetchPullRequestFilesOptions,
): Promise<PullRequestFilesResult> {
  const { owner, repo, pullNumber } = options;
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_PR_FILES);
  const declaredTotal =
    typeof options.changedFiles === "number" && options.changedFiles >= 0
      ? options.changedFiles
      : null;

  const trySingleDiff =
    options.preferDiff === true ||
    (options.preferDiff !== false &&
      (typeof octokit.rest?.pulls?.get === "function" ||
        typeof (octokit as any)?.request === "function"));

  const exceedsSingleDiffLimit =
    declaredTotal !== null && declaredTotal > GITHUB_SINGLE_DIFF_FILE_LIMIT;

  let singleDiffSucceeded = false;
  let singleDiffFiles: PullRequestFile[] = [];

  if (trySingleDiff && !exceedsSingleDiffLimit) {
    try {
      let diffData: unknown;
      let diffHeaders: Record<string, unknown> | undefined;

      if (typeof octokit.rest?.pulls?.get === "function") {
        const res = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: pullNumber,
          mediaType: { format: "diff" },
          headers: { accept: "application/vnd.github.v3.diff" },
        });
        diffData = res.data;
        diffHeaders = res.headers as Record<string, unknown> | undefined;
      } else if (typeof (octokit as any)?.request === "function") {
        const res = await (octokit as any).request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}",
          {
            owner,
            repo,
            pull_number: pullNumber,
            headers: { accept: "application/vnd.github.v3.diff" },
          },
        );
        diffData = res.data;
        diffHeaders = res.headers as Record<string, unknown> | undefined;
      }

      if (
        typeof diffData === "string" &&
        !isDiffResponseTruncated({ data: diffData, headers: diffHeaders })
      ) {
        const parsed = parseMultiFileUnifiedDiff(diffData);
        if (parsed.length > 0 || diffData.trim() === "") {
          singleDiffFiles = parsed.slice(0, maxFiles);
          singleDiffSucceeded = true;
        }
      }
    } catch (err) {
      // 406 Not Acceptable, diff-too-large, or any diff-fetch error falls back to paginated listFiles
      void err;
    }
  }

  if (singleDiffSucceeded) {
    const truncated = singleDiffFiles.length < (declaredTotal ?? singleDiffFiles.length);
    const unscanned = getUnscannedFiles(singleDiffFiles);
    return {
      files: singleDiffFiles,
      fetched: singleDiffFiles.length,
      truncated,
      totalChanged: declaredTotal ?? (truncated ? null : singleDiffFiles.length),
      unscannedFiles: unscanned,
      usedFallback: false,
    };
  }

  // Fallback: listing changed files with pagination and fetching each patch
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

  const truncated = hitCap || (declaredTotal !== null && declaredTotal > files.length);
  const unscanned = getUnscannedFiles(files);

  return {
    files,
    fetched: files.length,
    truncated,
    totalChanged: declaredTotal ?? (truncated ? null : files.length),
    unscannedFiles: unscanned,
    usedFallback: trySingleDiff || exceedsSingleDiffLimit,
  };
}

/** Most file names listed in the notice before it says "and N more". */
export const MAX_LISTED_UNDIFFED_FILES = 10;

/**
 * Changed files the scan could not read: GitHub returned them without a
 * `patch`.
 *
 * GitHub omits the patch for a binary file and for a text diff too large to
 * display (a big generated or minified file, a vendored bundle). The worker only
 * scans files that carry a patch, so these were dropped without a word — the
 * report still read "No vulnerabilities found in the N analyzed files", with N
 * quietly smaller than the number of files changed, and a credential pasted
 * into a large file never surfaced at all.
 *
 * Removed files are excluded (there is nothing left to scan), and so are files
 * the scanner ignores anyway (images, archives, lockfiles, `node_modules/`…),
 * which would otherwise make every notice noise.
 */
export function undiffedFiles(files: readonly PullRequestFile[]): string[] {
  return files
    .filter(
      (file) =>
        file.status !== "removed" &&
        (typeof file.patch !== "string" || file.patch === "") &&
        (ignoreReasonFor(file.filename) === null || ignoreReasonFor(file.filename) === "default"),
    )
    .map((file) => file.filename);
}

/**
 * Human-readable coverage line for the PR comment and the check run output.
 *
 * Covers both ways a scan can see less than the whole pull request: the file
 * list was truncated, or GitHub returned some files without a diff. Returns null
 * when the whole PR was analysed, so callers can omit the line entirely rather
 * than printing a reassurance nobody needs.
 */
export function formatCoverageNotice(result: PullRequestFilesResult): string | null {
  const notices: string[] = [];

  if (result.truncated) {
    const total = result.totalChanged;
    const scope = total === null ? "the first" : `${result.fetched} of ${total}`;

    notices.push(
      total === null
        ? `⚠️ This pull request changed more files than SecureFlow analyses in a single scan. Only ${scope} ${result.fetched} files were reviewed — findings in the remaining files are **not** reflected below.`
        : `⚠️ Only ${scope} changed files were analysed. Findings in the remaining ${total - result.fetched} file(s) are **not** reflected below.`,
    );
  }

  const undiffed = undiffedFiles(result.files ?? []);
  if (undiffed.length > 0) {
    const listed = undiffed
      .slice(0, MAX_LISTED_UNDIFFED_FILES)
      .map((name) => `\`${name.replace(/`/g, "'")}\``)
      .join(", ");
    const more =
      undiffed.length > MAX_LISTED_UNDIFFED_FILES
        ? ` and ${undiffed.length - MAX_LISTED_UNDIFFED_FILES} more`
        : "";

    notices.push(
      `⚠️ ${undiffed.length} changed file(s) were **not** analysed because GitHub did not return a diff for them (binary, or too large to display): ${listed}${more}.`,
    );
  }

  return notices.length > 0 ? notices.join("\n\n") : null;
}
