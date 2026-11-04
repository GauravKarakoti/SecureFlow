/**
 * Sticky pull request comment management for SecureFlow scan reports.
 *
 * Rather than creating a new comment on every push (synchronize event),
 * SecureFlow maintains a single "sticky" comment per PR identified by the
 * hidden marker `<!-- secureflow-report -->`.
 *
 * - When an existing comment is found, it is updated in-place.
 * - When no comment exists, a new one is created.
 * - If an existing comment was deleted (e.g. update returns 404), a new comment is created.
 * - The scanned commit SHA is displayed in the comment body.
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
        | { data?: Array<{ id: number; body?: string | null }> }
        | Array<{ id: number; body?: string | null }>
      >;
      createComment: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<
        | { data: { id: number; body?: string | null; [key: string]: unknown } }
        | { id: number; body?: string | null; [key: string]: unknown }
      >;
      updateComment?: (params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }) => Promise<
        | { data: { id: number; body?: string | null; [key: string]: unknown } }
        | { id: number; body?: string | null; [key: string]: unknown }
      >;
    };
  };
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
}

export interface UpsertSecureFlowCommentResult {
  data: {
    id: number;
    body?: string | null;
    [key: string]: unknown;
  };
  action: "created" | "updated";
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

/** Ensure the comment body contains the hidden marker. */
export function ensureSecureFlowMarker(body: string): string {
  if (body.includes(SECUREFLOW_COMMENT_MARKER)) {
    return body;
  }
  return `${SECUREFLOW_COMMENT_MARKER}\n\n${body}`;
}

/**
 * Searches the issue / pull request comments for one containing the SecureFlow hidden marker.
 * Supports pagination if comments exceed 100.
 */
export async function findSecureFlowComment(
  octokit: StickyCommentOctokit | any,
  params: FindSecureFlowCommentParams,
): Promise<{ id: number; body?: string | null } | null> {
  if (typeof octokit?.rest?.issues?.listComments !== "function") {
    return null;
  }

  let page = 1;
  const per_page = 100;

  while (true) {
    const res = await octokit.rest.issues.listComments({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.issueNumber,
      per_page,
      page,
    });

    const comments: Array<{ id: number; body?: string | null }> = Array.isArray(res)
      ? res
      : (res?.data ?? []);

    if (!comments || comments.length === 0) {
      break;
    }

    const found = comments.find(
      (c) => typeof c.body === "string" && c.body.includes(SECUREFLOW_COMMENT_MARKER),
    );
    if (found) {
      return found;
    }

    if (comments.length < per_page) {
      break;
    }
    page++;
  }

  return null;
}

/**
 * Creates or updates the sticky SecureFlow comment on a pull request.
 *
 * If `commentId` is provided or an existing marked comment is found, it attempts to update it.
 * If updating fails with a 404 (deleted comment) or no existing comment exists, it creates a new comment.
 */
export async function upsertSecureFlowComment(
  octokit: StickyCommentOctokit | any,
  params: UpsertSecureFlowCommentParams,
): Promise<UpsertSecureFlowCommentResult> {
  const body = ensureSecureFlowMarker(params.body);
  let targetCommentId = params.commentId;

  if (!targetCommentId) {
    const existing = await findSecureFlowComment(octokit, {
      owner: params.owner,
      repo: params.repo,
      issueNumber: params.issueNumber,
    });
    if (existing) {
      targetCommentId = existing.id;
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
