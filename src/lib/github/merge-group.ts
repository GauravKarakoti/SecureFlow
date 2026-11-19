/**
 * GitHub Merge Queue (`merge_group` event) handling (#1864).
 *
 * Repositories that use GitHub's merge queue run required status checks on a
 * temporary merge ref (e.g. `refs/heads/gh-readonly-queue/main/pr-123-abc123`).
 * This module provides pure, testable primitives to:
 *   1. Extract the associated pull request number from the merge group ref or commit.
 *   2. Fetch the combined diff of the temporary merge commit against the target base.
 *   3. Compare the merge group diff against the pull request diff to decide whether
 *      to reuse the previous PR scan result or run a scan of the combined diff.
 */

import { normalizeDiff } from "@/lib/scanner/scan-cache";
import type { FileChange } from "@/lib/armor/scanner";
import type { PullRequestFile } from "./pull-request-files";

export interface MergeGroupRefData {
  head_sha: string;
  base_sha?: string | null;
  head_ref?: string | null;
  base_ref?: string | null;
  head_commit?: {
    id?: string | null;
    message?: string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

/**
 * Extracts the PR number associated with a `merge_group` webhook event.
 *
 * GitHub Merge Queue names temporary refs according to the pattern:
 *   `refs/heads/gh-readonly-queue/<base_branch>/pr-<pr_number>-<base_sha>`
 *
 * If the ref pattern is customized or truncated, falls back to inspecting the
 * `head_commit.message` (e.g. `Merge pull request #123 from ...` or `fix: foo (#123)`).
 */
export function extractPrNumberFromMergeGroup(
  mergeGroup?: {
    head_ref?: string | null;
    head_commit?: { message?: string | null } | null;
  } | null,
): number | null {
  if (!mergeGroup) return null;

  if (typeof mergeGroup.head_ref === "string") {
    const refMatch =
      mergeGroup.head_ref.match(/\/pr-(\d+)-/i) ||
      mergeGroup.head_ref.match(/\/pr-(\d+)$/i) ||
      mergeGroup.head_ref.match(/\bpr-(\d+)\b/i);
    if (refMatch && refMatch[1]) {
      const parsed = parseInt(refMatch[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }

  if (typeof mergeGroup.head_commit?.message === "string") {
    const msgMatch =
      mergeGroup.head_commit.message.match(/Merge pull request #(\d+)/i) ||
      mergeGroup.head_commit.message.match(/#(\d+)\b/);
    if (msgMatch && msgMatch[1]) {
      const parsed = parseInt(msgMatch[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }

  return null;
}

export interface MergeGroupDiffClient {
  rest: {
    repos: {
      compareCommits: (params: {
        owner: string;
        repo: string;
        base: string;
        head: string;
      }) => Promise<{
        data: {
          files?: Array<{
            filename: string;
            status?: string;
            patch?: string;
            [key: string]: unknown;
          }>;
        };
      }>;
    };
  };
}

export interface MergeGroupFile {
  filename: string;
  patch: string;
  status?: string;
}

/**
 * Fetches the files changed in a merge group by comparing the target base SHA
 * and the merge group head SHA.
 */
export async function fetchMergeGroupFiles(
  octokit: MergeGroupDiffClient,
  options: {
    owner: string;
    repo: string;
    baseSha: string;
    headSha: string;
  },
): Promise<MergeGroupFile[]> {
  const { owner, repo, baseSha, headSha } = options;
  const response = await octokit.rest.repos.compareCommits({
    owner,
    repo,
    base: baseSha,
    head: headSha,
  });

  const files = response.data.files || [];
  return files
    .filter((file) => typeof file.patch === "string" && file.status !== "removed")
    .map((file) => ({
      filename: file.filename,
      patch: file.patch as string,
      status: file.status,
    }));
}

/**
 * Compares the normalized diff of the merge group with the PR's normalized diff.
 * Returns true if the semantic content of the changes is identical, meaning
 * the PR result can be safely reused without a full LLM re-scan.
 */
export function isMergeGroupDiffUnchanged(
  mergeGroupFiles: FileChange[],
  prFiles: FileChange[],
): boolean {
  const mergeNormalized = normalizeDiff(mergeGroupFiles);
  const prNormalized = normalizeDiff(prFiles);
  return mergeNormalized === prNormalized;
}
