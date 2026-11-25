/**
 * Sticky pull request comment management for SecureFlow scan reports (#2012).
 *
 * Rather than letting multiple comments accumulate across pushes, SecureFlow
 * maintains exactly one current comment per PR identified by the hidden marker
 * `<!-- secureflow-report -->`.
 *
 * To avoid cluttering PRs with edit history or stale comments:
 * - Existing SecureFlow comments can be deleted and replaced with a fresh comment,
 *   or updated in place.
 * - Outdated extra SecureFlow comments can also be minimized using the GraphQL
 *   `minimizeComment` mutation with classifier `OUTDATED`.
 * - If a comment was already deleted, operations fall back gracefully without errors.
 * - The scanned commit SHA and scan time are displayed in the comment body.
 */

export const SECUREFLOW_COMMENT_MARKER = "<!-- secureflow-report -->";

export interface StickyCommentOctokit {
  rest: {
    issues: {
      listComments?: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }) => Promise<
        | { data?: Array<{ id: number; node_id?: string; body?: string | null }> }
        | Array<{ id: number; node_id?: string; body?: string | null }>
      >;
      createComment: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<
        | { data: { id: number; node_id?: string; body?: string | null; [key: string]: unknown } }
        | { id: number; node_id?: string; body?: string | null; [key: string]: unknown }
      >;
      updateComment?: (params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }) => Promise<
        | { data: { id: number; node_id?: string; body?: string | null; [key: string]: unknown } }
        | { id: number; node_id?: string; body?: string | null; [key: string]: unknown }
      >;
      deleteComment?: (params: {
        owner: string;
        repo: string;
        comment_id: number;
      }) => Promise<unknown>;
    };
  };
  graphql?: (query: string, variables?: Record<string, unknown>) => Promise<unknown>;
}

export interface FindSecureFlowCommentParams {
  owner: string;
  repo: string;
  issueNumber: number;
}

export interface UpsertSecureFlowCommentParams {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  commentId?: number | null;
  commitSha?: string | null;
  scanTime?: string | Date | null;
  /**
   * When true, deletes existing comment(s) first and creates a clean new comment,
   * avoiding comment bloat and edit history per project owner request (#2012).
   */
  replaceOldComments?: boolean;
}

export interface UpsertSecureFlowCommentResult {
  data: {
    id: number;
    body?: string | null;
    [key: string]: unknown;
  };
  action: "created" | "updated" | "replaced";
}

/** Check whether an error represents a 404 Not Found from GitHub or HTTP client. */
export function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const err = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    message?: unknown;
  };
  if (err.status === 404 || err.statusCode === 404 || err.response?.status === 404) {
    return true;
  }
  if (typeof err.message === "string" && err.message.toLowerCase().includes("not found")) {
    return true;
  }
  return false;
}

/** Check whether a comment body contains the SecureFlow hidden marker or report header. */
export function isSecureFlowComment(body: string | null | undefined): boolean {
  if (typeof body !== "string") {
    return false;
  }
  return (
    body.includes(SECUREFLOW_COMMENT_MARKER) ||
    body.includes("<!-- secureflow") ||
    body.includes("SecureFlow AI Security Report")
  );
}

/** Ensure the comment body contains the hidden marker. */
export function ensureSecureFlowMarker(body: string): string {
  if (body.includes(SECUREFLOW_COMMENT_MARKER)) {
    return body;
  }
  return `${SECUREFLOW_COMMENT_MARKER}\n\n${body}`;
}

/** Formats the commit SHA and scan time metadata lines for comment bodies. */
export function formatScanMetadata(params: {
  commitSha?: string | null;
  scanTime?: string | Date | null;
}): string {
  const lines: string[] = [];
  if (params.commitSha) {
    lines.push(`Scanned commit: \`${params.commitSha}\``);
  }
  if (params.scanTime) {
    const formatted =
      params.scanTime instanceof Date ? params.scanTime.toISOString() : params.scanTime;
    lines.push(`Scan time: \`${formatted}\``);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n\n` : "";
}

export interface SecureFlowCommentItem {
  id: number;
  node_id?: string;
  body?: string | null;
}

/**
 * Lists all comments containing the SecureFlow hidden marker on an issue/PR.
 * Handles pagination.
 */
export async function findAllSecureFlowComments(
  octokit: StickyCommentOctokit | any,
  params: FindSecureFlowCommentParams,
): Promise<SecureFlowCommentItem[]> {
  if (typeof octokit?.rest?.issues?.listComments !== "function") {
    return [];
  }

  let page = 1;
  const per_page = 100;
  const matches: SecureFlowCommentItem[] = [];

  while (true) {
    const res = await octokit.rest.issues.listComments({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.issueNumber,
      per_page,
      page,
    });

    const comments: SecureFlowCommentItem[] = Array.isArray(res) ? res : (res?.data ?? []);

    if (!comments || comments.length === 0) {
      break;
    }

    for (const c of comments) {
      if (isSecureFlowComment(c.body)) {
        matches.push(c);
      }
    }

    if (comments.length < per_page) {
      break;
    }
    page++;
  }

  return matches;
}

/**
 * Searches the issue / pull request comments for one containing the SecureFlow hidden marker.
 * Supports pagination if comments exceed 100.
 */
export async function findSecureFlowComment(
  octokit: StickyCommentOctokit | any,
  params: FindSecureFlowCommentParams,
): Promise<SecureFlowCommentItem | null> {
  const all = await findAllSecureFlowComments(octokit, params);
  return all.length > 0 ? all[0] : null;
}

/**
 * Minimizes an outdated comment using the GitHub GraphQL API.
 * Falls back silently if GraphQL is unavailable or fails.
 */
export async function minimizeOutdatedComment(
  octokit: StickyCommentOctokit | any,
  nodeId: string,
  classifier: "OUTDATED" | "RESOLVED" | "OFF_TOPIC" | "DUPLICATE" = "OUTDATED",
): Promise<boolean> {
  if (typeof octokit?.graphql !== "function" || !nodeId) {
    return false;
  }

  const query = `
    mutation MinimizeOutdatedComment($input: MinimizeCommentInput!) {
      minimizeComment(input: $input) {
        minimizedComment {
          isMinimized
          minimizedReason
        }
      }
    }
  `;

  try {
    await octokit.graphql(query, {
      input: {
        subjectId: nodeId,
        classifier,
      },
    });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Safely deletes a comment by ID.
 * Returns true if deleted, false if not found or cannot delete.
 */
export async function deleteCommentSafely(
  octokit: StickyCommentOctokit | any,
  params: { owner: string; repo: string; commentId: number },
): Promise<boolean> {
  if (typeof octokit?.rest?.issues?.deleteComment !== "function") {
    return false;
  }

  try {
    await octokit.rest.issues.deleteComment({
      owner: params.owner,
      repo: params.repo,
      comment_id: params.commentId,
    });
    return true;
  } catch (err: unknown) {
    if (isNotFoundError(err)) {
      return false;
    }
    return false;
  }
}

/**
 * Replaces old comments on a PR by deleting them and creating a fresh comment.
 * If deletion fails or is unsupported, minimizes extra comments as outdated.
 */
export async function replaceSecureFlowComment(
  octokit: StickyCommentOctokit | any,
  params: UpsertSecureFlowCommentParams,
): Promise<UpsertSecureFlowCommentResult> {
  let rawBody = params.body;
  if (
    (params.commitSha || params.scanTime) &&
    !rawBody.includes("Scanned commit:") &&
    !rawBody.includes("Scan time:")
  ) {
    const meta = formatScanMetadata({
      commitSha: params.commitSha,
      scanTime: params.scanTime,
    });
    rawBody = meta + rawBody;
  }
  const body = ensureSecureFlowMarker(rawBody);
  const existingComments = await findAllSecureFlowComments(octokit, {
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
  });

  // Delete all existing SecureFlow comments so PR is not stuffed with commits/history
  if (existingComments.length > 0) {
    await Promise.all(
      existingComments.map(async (c) => {
        const deleted = await deleteCommentSafely(octokit, {
          owner: params.owner,
          repo: params.repo,
          commentId: c.id,
        });

        // If deleteComment wasn't supported or failed, minimize as outdated via GraphQL
        if (!deleted && c.node_id) {
          await minimizeOutdatedComment(octokit, c.node_id, "OUTDATED");
        }
      }),
    );
  }

  // Create clean new comment
  const response = await octokit.rest.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.issueNumber,
    body,
  });

  const data = response && "data" in response && response.data ? response.data : response;
  return { data, action: "created" };
}

/**
 * Creates, updates, or replaces the sticky SecureFlow comment on a pull request.
 *
 * - If `replaceOldComments` is true: deletes previous SecureFlow comment(s) and creates a new one,
 *   minimizing any non-deletable extras as outdated via GraphQL (#2012).
 * - Otherwise: updates existing in-place, minimizing extras as outdated if multiple comments exist.
 * - If updating fails with a 404 (deleted comment) or no existing comment exists, creates a new comment.
 */
export async function upsertSecureFlowComment(
  octokit: StickyCommentOctokit | any,
  params: UpsertSecureFlowCommentParams,
): Promise<UpsertSecureFlowCommentResult> {
  if (params.replaceOldComments) {
    return replaceSecureFlowComment(octokit, params);
  }

  let rawBody = params.body;
  if (
    (params.commitSha || params.scanTime) &&
    !rawBody.includes("Scanned commit:") &&
    !rawBody.includes("Scan time:")
  ) {
    const meta = formatScanMetadata({
      commitSha: params.commitSha,
      scanTime: params.scanTime,
    });
    rawBody = meta + rawBody;
  }
  const body = ensureSecureFlowMarker(rawBody);
  let targetCommentId = params.commentId;

  // When commentId is not provided, query comments to find target and minimize any extra stale comments
  if (!targetCommentId) {
    const existingComments = await findAllSecureFlowComments(octokit, {
      owner: params.owner,
      repo: params.repo,
      issueNumber: params.issueNumber,
    });

    if (existingComments.length > 0) {
      targetCommentId = existingComments[0].id;

      // If extra comments exist from earlier versions/runs, minimize them as outdated
      if (existingComments.length > 1) {
        const extraComments = existingComments.slice(1);
        await Promise.all(
          extraComments.map(async (c) => {
            if (c.node_id) {
              await minimizeOutdatedComment(octokit, c.node_id, "OUTDATED");
            }
          }),
        );
      }
    }
  }

  if (targetCommentId && typeof octokit?.rest?.issues?.updateComment === "function") {
    try {
      const response = await octokit.rest.issues.updateComment({
        owner: params.owner,
        repo: params.repo,
        comment_id: targetCommentId,
        body,
      });
      const data = response && "data" in response && response.data ? response.data : response;
      return { data, action: "updated" };
    } catch (error: unknown) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      // Comment was deleted; fall through to createComment
    }
  }

  const response = await octokit.rest.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.issueNumber,
    body,
  });

  const data = response && "data" in response && response.data ? response.data : response;
  return { data, action: "created" };
}
