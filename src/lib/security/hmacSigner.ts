/**
 * HMAC-SHA256 webhook signature generator and validator.
 *
 * Signs outbound webhook payloads with `X-SecureFlow-Signature` headers
 * and verifies inbound signatures with constant-time comparison.
 *
 * Usage (signing):
 *   import { signPayload, SIGNATURE_HEADER } from '@/lib/security/hmacSigner';
 *   const signature = signPayload(payload, secret);
 *   headers.set(SIGNATURE_HEADER, signature);
 *
 * Usage (verification):
 *   import { verifySignature } from '@/lib/security/hmacSigner';
 *   const valid = verifySignature(payload, secret, signatureHeader);
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** Header name used for HMAC-SHA256 signatures. */
export const SIGNATURE_HEADER = 'X-SecureFlow-Signature';

/** Header name for the request timestamp (replay protection). */
export const TIMESTAMP_HEADER = 'X-SecureFlow-Timestamp';

/** Signature prefix: `sha256=<hex>`. */
const SIGNATURE_PREFIX = 'sha256=';

/** SHA-256 hex digest is exactly 64 characters. */
const SIGNATURE_HEX_LENGTH = 64;

/** Default replay window: 5 minutes (300 seconds). */
export const DEFAULT_REPLAY_WINDOW_SECONDS = 300;

/**
 * Sign a payload with HMAC-SHA256.
 *
 * @param payload - The raw payload string to sign.
 * @param secret - The shared secret key.
 * @returns The signature in `sha256=<hex>` format, suitable for the
 *   `X-SecureFlow-Signature` header.
 */
export function signPayload(payload: string, secret: string): string {
  const digest = createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');
  return `${SIGNATURE_PREFIX}${digest}`;
}

/**
 * Verify an HMAC-SHA256 signature with constant-time comparison.
 *
 * @param payload - The raw payload string that was signed.
 * @param secret - The shared secret key.
 * @param signatureHeader - The full signature header value (e.g. `sha256=...`).
 * @returns `true` if the signature is valid.
 */
export function verifySignature(
  payload: string,
  secret: string,
  signatureHeader: string
): boolean {
  const expectedHex = extractHex(signatureHeader);
  if (!expectedHex) return false;

  const digest = createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');

  const expected = Buffer.from(expectedHex, 'hex');
  const provided = Buffer.from(digest, 'hex');

  if (provided.length !== expected.length) return false;

  return timingSafeEqual(provided, expected);
}

/**
 * Extract the hex digest from a `sha256=<hex>` signature header.
 *
 * Validates the format strictly: correct prefix, exactly 64 hex chars.
 */
function extractHex(signatureHeader: string | null | undefined): string | null {
  if (typeof signatureHeader !== 'string') return null;
  if (!signatureHeader.toLowerCase().startsWith(SIGNATURE_PREFIX)) return null;

  const hex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (hex.length !== SIGNATURE_HEX_LENGTH) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;

  return hex.toLowerCase();
}

/**
 * Parse a timestamp from the `X-SecureFlow-Timestamp` header.
 *
 * @param timestampHeader - The raw header value (Unix epoch seconds as string).
 * @returns The parsed timestamp in milliseconds, or `null` if invalid.
 */
export function parseTimestamp(timestampHeader: string | null | undefined): number | null {
  if (typeof timestampHeader !== 'string') return null;

  const trimmed = timestampHeader.trim();
  if (!trimmed) return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;

  // Convert seconds to milliseconds
  return parsed * 1000;
}

/**
 * Check whether a timestamp is within the replay protection window.
 *
 * @param timestampMs - The request timestamp in milliseconds.
 * @param toleranceSeconds - Maximum age in seconds (default: 300 = 5 minutes).
 * @returns `true` if the timestamp is within the allowed window.
 */
export function isWithinReplayWindow(
  timestampMs: number,
  toleranceSeconds: number = DEFAULT_REPLAY_WINDOW_SECONDS
): boolean {
  const now = Date.now();
  const toleranceMs = toleranceSeconds * 1000;
  const diff = Math.abs(now - timestampMs);
  return diff <= toleranceMs;
}

/**
 * Full admission check for an inbound webhook request.
 *
 * Combines signature verification and replay protection into a single
 * decision function.
 *
 * @param payload - The raw request body.
 * @param secret - The shared HMAC secret.
 * @param signatureHeader - The `X-SecureFlow-Signature` header value.
 * @param timestampHeader - The `X-SecureFlow-Timestamp` header value.
 * @param replayWindowSeconds - Maximum allowed age (default: 300).
 * @returns An admission result with `ok: true` or an error message.
 */
export function admitWebhookRequest(
  payload: string,
  secret: string,
  signatureHeader: string | null | undefined,
  timestampHeader: string | null | undefined,
  replayWindowSeconds: number = DEFAULT_REPLAY_WINDOW_SECONDS
): { ok: true } | { ok: false; status: number; message: string } {
  // 1. Signature required
  if (!signatureHeader) {
    return { ok: false, status: 401, message: 'Missing signature header' };
  }

  // 2. Timestamp required for replay protection
  if (!timestampHeader) {
    return { ok: false, status: 401, message: 'Missing timestamp header' };
  }

  const timestampMs = parseTimestamp(timestampHeader);
  if (timestampMs === null) {
    return { ok: false, status: 400, message: 'Invalid timestamp format' };
  }

  // 3. Check replay window (reject old requests)
  if (!isWithinReplayWindow(timestampMs, replayWindowSeconds)) {
    return { ok: false, status: 401, message: 'Request timestamp outside allowed window' };
  }

  // 4. Verify signature (constant-time)
  if (!verifySignature(payload, secret, signatureHeader)) {
    return { ok: false, status: 401, message: 'Invalid signature' };
  }

  return { ok: true };
}
