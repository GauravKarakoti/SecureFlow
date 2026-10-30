/**
 * GitLab webhook signature verification (#1466).
 *
 * GitLab sends an `X-Gitlab-Token` header containing a secret token that is
 * compared directly (not HMAC-derived). This is a symmetric-equality check
 * rather than a timing-safe HMAC comparison, so we use `timingSafeEqual` from
 * Node's `crypto` module to prevent timing-side-channel attacks.
 *
 * References:
 * - https://docs.gitlab.com/ee/user/project/integrations/webhooks.html#secret-token
 */

import { timingSafeEqual } from "crypto";

export const GITLAB_TOKEN_HEADER = "x-gitlab-token";
export const GITLAB_EVENT_HEADER = "x-gitlab-event";

/** Maximum payload size accepted from GitLab (1 MiB by default). */
export const GITLAB_MAX_PAYLOAD_BYTES = 1_048_576;

/**
 * GitLab event types that SecureFlow currently processes.
 */
export type GitLabEventType =
  | "Push Hook"
  | "Merge Request Hook"
  | "Tag Push Hook"
  | "Note Hook"
  | "Issue Hook"
  | "Pipeline Hook"
  | "Job Hook";

const TRACKED_GITLAB_EVENTS = new Set<GitLabEventType>([
  "Push Hook",
  "Merge Request Hook",
  "Pipeline Hook",
]);

/**
 * Parses the X-Gitlab-Token header value.
 * Returns null when the header is missing or empty.
 */
export function parseGitLabToken(headerValue: string | null): string | null {
  if (!headerValue || !headerValue.trim()) return null;
  return headerValue.trim();
}

/**
 * Parses the X-Gitlab-Event header value.
 * Returns null when the header is missing.
 */
export function parseGitLabEvent(headerValue: string | null): string | null {
  if (!headerValue || !headerValue.trim()) return null;
  return headerValue.trim();
}

/**
 * Verifies a GitLab webhook token using timing-safe comparison.
 *
 * @param receivedToken - Token from the X-Gitlab-Token header.
 * @param expectedSecret - The configured shared secret.
 * @returns true if the tokens match, false otherwise.
 */
export function verifyGitLabToken(
  receivedToken: string,
  expectedSecret: string,
): boolean {
  if (!receivedToken || !expectedSecret) return false;

  try {
    const received = Buffer.from(receivedToken, "utf8");
    const expected = Buffer.from(expectedSecret, "utf8");

    // Tokens must be the same byte length for timingSafeEqual; a length
    // mismatch is itself a secure rejection — no need to pad and risk oracle.
    if (received.length !== expected.length) return false;

    return timingSafeEqual(received, expected);
  } catch {
    return false;
  }
}

/**
 * Returns true when the GitLab event type is one SecureFlow processes.
 * Unrecognised events are still acknowledged with 200 but not dispatched.
 */
export function isTrackedGitLabEvent(event: string): event is GitLabEventType {
  return TRACKED_GITLAB_EVENTS.has(event as GitLabEventType);
}

/**
 * Extracts a safe, non-reflected label for logging from a GitLab event header.
 * Unknown event strings are reported as "unknown" to prevent log injection.
 */
export function safeGitLabEventLabel(event: string | null): string {
  if (!event) return "unknown";
  if (event.length > 64) return "unknown";
  return TRACKED_GITLAB_EVENTS.has(event as GitLabEventType) ? event : "untracked";
}
