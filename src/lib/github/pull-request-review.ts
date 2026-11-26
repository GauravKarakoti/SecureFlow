/**
 * Pull Request Review Mode (#2095)
 *
 * Provides opt-in pull request review automation:
 * - Submits a PR review with `REQUEST_CHANGES` when a scan is blocked.
 * - Dismisses previous `CHANGES_REQUESTED` review(s) or replaces with a neutral `COMMENT` review
 *   when the next scan passes.
 * - NEVER approves a PR automatically (`APPROVE` is strictly forbidden).
 * - Handles missing permissions gracefully with a warning, without causing scan failure.
 */

export const SECUREFLOW_REVIEW_MARKER = "<!-- secureflow-review-marker -->";

export interface PullRequestReviewConfig {
  /**
   * Whether review mode is enabled. Opt-in by default (defaults to false).
   */
  enabled?: boolean;
  /**
   * Action to take when scan is blocked. Defaults to "REQUEST_CHANGES".
   */
  blockedEvent?: "REQUEST_CHANGES" | "COMMENT";
  /**
   * Whether to dismiss previous changes-requested reviews when scan passes. Defaults to true.
   */
  dismissOnPass?: boolean;
  /**
   * Custom message for the review when changes are requested.
   */
  blockedMessage?: string;
  /**
   * Custom message for review comment or dismissal when scan passes.
   */
  passedMessage?: string;
}

export interface ReviewClient {
  rest: {
    pulls: {
      createReview: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        event: "REQUEST_CHANGES" | "COMMENT";
        body: string;
      }) => Promise<unknown>;
      listReviews?: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
      }) => Promise<{
        data: Array<{
          id: number;
          user?: { login?: string } | null;
          state: string;
          body?: string | null;
        }>;
      }>;
      dismissReview?: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        review_id: number;
        message: string;
      }) => Promise<unknown>;
    };
  };
}

export interface SyncPullRequestReviewParams {
  client: ReviewClient;
  owner: string;
  repo: string;
  prNumber: number;
  isBlocked: boolean;
  findingsCount: number;
  config?: PullRequestReviewConfig;
  appLogin?: string;
  headSha?: string;
}

export interface SyncPullRequestReviewResult {
  action:
    | "REQUESTED_CHANGES"
    | "DISMISSED_REVIEW"
    | "COMMENTED_PASS"
    | "SKIPPED_NOT_CONFIGURED"
    | "SKIPPED_ALREADY_REQUESTED"
    | "FAILED_GRACEFULLY";
  reviewId?: number;
  dismissedReviewIds?: number[];
  warning?: string;
}

/**
 * Syncs the pull request review status based on the scan verdict (#2095).
 * - If blocked and review mode enabled -> submits a review with REQUEST_CHANGES.
 * - If passing -> dismisses previous CHANGES_REQUESTED reviews or posts a neutral comment.
 * - NEVER creates an APPROVE review.
 */
export async function syncPullRequestReview(
  params: SyncPullRequestReviewParams,
): Promise<SyncPullRequestReviewResult> {
  const { client, owner, repo, prNumber, isBlocked, findingsCount, config = {} } = params;

  if (!config.enabled) {
    return { action: "SKIPPED_NOT_CONFIGURED" };
  }

  // Double check security guarantee: Never approve
  // Even if config tries to specify APPROVE, enforce REQUEST_CHANGES or COMMENT
  const blockedEvent: "REQUEST_CHANGES" | "COMMENT" =
    config.blockedEvent === "COMMENT" ? "COMMENT" : "REQUEST_CHANGES";

  try {
    if (isBlocked) {
      // 1. Scan is BLOCKED -> Check existing reviews to avoid spamming multiple identical REQUEST_CHANGES
      if (client?.rest?.pulls?.listReviews) {
        try {
          const existingReviews = await client.rest.pulls.listReviews({
            owner,
            repo,
            pull_number: prNumber,
            per_page: 50,
          });

          const appUser = params.appLogin?.toLowerCase();
          const activeChangesRequested = existingReviews.data.find((r) => {
            const isOurUser = !appUser || (r.user?.login && r.user.login.toLowerCase() === appUser);
            const hasMarker = r.body?.includes(SECUREFLOW_REVIEW_MARKER);
            return (isOurUser || hasMarker) && r.state === "CHANGES_REQUESTED";
          });

          if (activeChangesRequested) {
            // Already has an active CHANGES_REQUESTED review on this PR
            return {
              action: "SKIPPED_ALREADY_REQUESTED",
              reviewId: activeChangesRequested.id,
            };
          }
        } catch (listErr) {
          console.warn(
            `[PRReview] Could not list existing reviews for ${owner}/${repo}#${prNumber}:`,
            listErr,
          );
        }
      }

      // Submit REQUEST_CHANGES review
      const body =
        `${SECUREFLOW_REVIEW_MARKER}\n### 🛑 SecureFlow Security Gate: Changes Requested\n\n` +
        (config.blockedMessage ||
          `This pull request is blocked because SecureFlow detected **${findingsCount}** blocking security issue(s) matching your repository code policies.\n\n` +
            `Please address the findings reported in the scan check-run or secureflow report before merging.`);

      const reviewRes = await client.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        event: blockedEvent,
        body,
      });

      const reviewId =
        (reviewRes as { data?: { id?: number }; id?: number })?.data?.id ??
        (reviewRes as { id?: number })?.id;

      return {
        action: "REQUESTED_CHANGES",
        reviewId,
      };
    } else {
      // 2. Scan is PASSING -> Dismiss previous CHANGES_REQUESTED review(s) or post comment
      const dismissedReviewIds: number[] = [];
      const dismissOnPass = config.dismissOnPass !== false;

      if (dismissOnPass && client?.rest?.pulls?.listReviews && client?.rest?.pulls?.dismissReview) {
        try {
          const existingReviews = await client.rest.pulls.listReviews({
            owner,
            repo,
            pull_number: prNumber,
            per_page: 50,
          });

          const appUser = params.appLogin?.toLowerCase();
          const reviewsToDismiss = existingReviews.data.filter((r) => {
            const isOurUser = !appUser || (r.user?.login && r.user.login.toLowerCase() === appUser);
            const hasMarker = r.body?.includes(SECUREFLOW_REVIEW_MARKER);
            return (isOurUser || hasMarker) && r.state === "CHANGES_REQUESTED";
          });

          for (const review of reviewsToDismiss) {
            try {
              const dismissalMsg =
                config.passedMessage ||
                "SecureFlow scan passed: blocking findings have been resolved or suppressed.";
              await client.rest.pulls.dismissReview({
                owner,
                repo,
                pull_number: prNumber,
                review_id: review.id,
                message: dismissalMsg,
              });
              dismissedReviewIds.push(review.id);
            } catch (dismissErr) {
              console.warn(
                `[PRReview] Failed to dismiss review ${review.id} for ${owner}/${repo}#${prNumber}:`,
                dismissErr,
              );
            }
          }

          if (dismissedReviewIds.length > 0) {
            return {
              action: "DISMISSED_REVIEW",
              dismissedReviewIds,
            };
          }
        } catch (listErr) {
          console.warn(
            `[PRReview] Could not list existing reviews to dismiss for ${owner}/${repo}#${prNumber}:`,
            listErr,
          );
        }
      }

      // If no review was dismissed or dismissal is not supported/wanted, we do NOT submit APPROVE!
      // We can optionally submit a neutral COMMENT review if configured or simply return SKIPPED_NOT_CONFIGURED.
      return {
        action: "COMMENTED_PASS",
      };
    }
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    console.warn(
      `[PRReview] Missing permissions or API error while updating PR review on ${owner}/${repo}#${prNumber}: ${errorMsg}`,
    );
    return {
      action: "FAILED_GRACEFULLY",
      warning: errorMsg,
    };
  }
}
