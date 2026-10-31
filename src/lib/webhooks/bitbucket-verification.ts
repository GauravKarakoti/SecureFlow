/**
 * Bitbucket Server / Bitbucket Cloud webhook HMAC-SHA256 signature verification (#1466).
 *
 * Bitbucket Cloud sends an `X-Hub-Signature` header with the format `sha256=<hex>`.
 * Bitbucket Server (Data Center) sends an `X-Hub-Signature` header with the same
 * format as GitHub: `sha256=<hex>`.
 *
 * SecureFlow uses the same HMAC-SHA256 approach as the GitHub webhook handler,
 * deriving the expected digest over the raw request body and comparing
 * timing-safely via `timingSafeEqual`.
 *
 * References:
 * - https://support.atlassian.com/bitbucket-cloud/docs/manage-webhooks/
 * - https://confluence.atlassian.com/bitbucketserver/event-payload-938025882.html
 */

import { createHmac, timingSafeEqual } from "crypto";

/** Header that Bitbucket Cloud and Server send the HMAC digest in. */
export const BITBUCKET_SIGNATURE_HEADER = "x-hub-signature";

/** Header carrying the delivery / event UUID. */
export const BITBUCKET_REQUEST_UUID_HEADER = "x-request-uuid";

/** Header identifying the event type (e.g., `repo:push`). */
export const BITBUCKET_EVENT_HEADER = "x-event-key";

/** Maximum accepted payload size (1 MiB). */
export const BITBUCKET_MAX_PAYLOAD_BYTES = 1_048_576;

/**
 * Bitbucket event keys SecureFlow processes.
 */
export type BitbucketEventKey =
  | "repo:push"
  | "pullrequest:created"
  | "pullrequest:updated"
  | "pullrequest:fulfilled"
  | "pullrequest:rejected"
  | "repo:refs_changed"; // Bitbucket Server push

const TRACKED_BITBUCKET_EVENTS = new Set<BitbucketEventKey>([
  "repo:push",
  "pullrequest:created",
  "pullrequest:updated",
  "pullrequest:fulfilled",
  "repo:refs_changed",
]);

/**
 * Parses the X-Hub-Signature header produced by Bitbucket.
 *
 * Expected format: `sha256=<64-char-hex>` (Bitbucket Cloud) or
 * `sha256=<hex>` (Bitbucket Server). Returns null on any parse failure.
 */
export function parseBitbucketSignature(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /^sha256=([0-9a-fA-F]+)$/.exec(headerValue.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * Parses the X-Request-UUID header.
 * Returns a normalised lowercase string or null when missing/empty.
 */
export function parseBitbucketRequestUuid(headerValue: string | null): string | null {
  if (!headerValue || !headerValue.trim()) return null;
  return headerValue.trim().toLowerCase();
}

/**
 * Parses the X-Event-Key header.
 */
export function parseBitbucketEventKey(headerValue: string | null): string | null {
  if (!headerValue || !headerValue.trim()) return null;
  return headerValue.trim();
}

/**
 * Computes the expected HMAC-SHA256 digest for a Bitbucket payload.
 *
 * Bitbucket signs the raw body bytes using a pre-shared secret.
 */
export function computeBitbucketHmac(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/**
 * Performs timing-safe HMAC signature verification for a Bitbucket webhook.
 *
 * @param receivedHex  - Hex digest from the X-Hub-Signature header (without prefix).
 * @param secret       - Configured shared secret.
 * @param body         - Raw request body string.
 * @returns true when the signature is valid.
 */
export function verifyBitbucketSignature(
  receivedHex: string,
  secret: string,
  body: string,
): boolean {
  if (!receivedHex || !secret) return false;

  try {
    const expected = computeBitbucketHmac(secret, body);
    const receivedBuf = Buffer.from(receivedHex, "hex");
    const expectedBuf = Buffer.from(expected, "hex");

    if (receivedBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(receivedBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Returns true when the Bitbucket event key is one SecureFlow processes.
 */
export function isTrackedBitbucketEvent(key: string): key is BitbucketEventKey {
  return TRACKED_BITBUCKET_EVENTS.has(key as BitbucketEventKey);
}

/**
 * Returns a safe, non-reflected label for logging.
 */
export function safeBitbucketEventLabel(event: string | null): string {
  if (!event) return "unknown";
  if (event.length > 64) return "unknown";
  return TRACKED_BITBUCKET_EVENTS.has(event as BitbucketEventKey) ? event : "untracked";
}
