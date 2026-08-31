/**
 * HMAC-SHA256 webhook signature generator and validator.
 *
 * SecureFlow speaks two signature formats on `X-SecureFlow-Signature`, and this
 * module is the one place that knows both.
 *
 * **v1 (canonical).** `t=<unix-seconds>,v1=<hex>`, digest over
 * `` `${timestamp}.${body}` ``. This is what `src/lib/queue/outbound-dispatch.ts`
 * emits on every outbound delivery, and what new senders should produce. The
 * timestamp is inside the signed material, so a replay cannot be refreshed by
 * rewriting the `X-SecureFlow-Timestamp` header — the window and the signature
 * are checking the same number.
 *
 * **legacy.** `sha256=<hex>`, digest over the bare body. Still accepted, because
 * senders configured against the previous shape of this module are already
 * sending it, but it is weaker: the digest does not cover a timestamp, so the
 * replay window is enforced against an unauthenticated header. Prefer v1.
 *
 * Before #716 this module knew only the legacy format, which meant SecureFlow
 * rejected the webhooks SecureFlow sent: `verifySignature` returned `false` for
 * a correctly signed v1 delivery, because `extractHex` required a `sha256=`
 * prefix that the outbound dispatcher has never produced.
 *
 * Usage (signing):
 *   import { signPayloadV1, SIGNATURE_HEADER } from '@/lib/security/hmacSigner';
 *   headers.set(SIGNATURE_HEADER, signPayloadV1(payload, secret, unixSeconds));
 *
 * Usage (verification):
 *   import { admitWebhookRequest } from '@/lib/security/hmacSigner';
 *   const result = admitWebhookRequest(body, secret, sigHeader, tsHeader);
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** Header name used for HMAC-SHA256 signatures. */
export const SIGNATURE_HEADER = 'X-SecureFlow-Signature';

/** Header name for the request timestamp (replay protection). */
export const TIMESTAMP_HEADER = 'X-SecureFlow-Timestamp';

/**
 * Version tag on the canonical signature header.
 *
 * Must match `SIGNATURE_VERSION` in `src/lib/queue/outbound-dispatch.ts`; the
 * contract test in this module's spec asserts that it does.
 */
export const SIGNATURE_VERSION = 'v1';

/** Legacy signature prefix: `sha256=<hex>`. */
const SIGNATURE_PREFIX = 'sha256=';

/** SHA-256 hex digest is exactly 64 characters. */
const SIGNATURE_HEX_LENGTH = 64;

/** Default replay window: 5 minutes (300 seconds). */
export const DEFAULT_REPLAY_WINDOW_SECONDS = 300;

/**
 * How far the `t=` inside a v1 signature may sit from the
 * `X-SecureFlow-Timestamp` header before the request is refused.
 *
 * They are written by the same sender in the same breath, so any real gap is
 * zero. A non-zero gap means someone is presenting a signature that covers one
 * timestamp while asking the replay window to check a different one, which is
 * the manoeuvre the v1 scheme exists to stop.
 */
const TIMESTAMP_AGREEMENT_SECONDS = 1;

/** A parsed `X-SecureFlow-Signature` value. */
export type ParsedSignature =
  | { scheme: 'v1'; hex: string; timestampSeconds: number }
  | { scheme: 'legacy'; hex: string };

/**
 * Sign a payload with the canonical v1 scheme.
 *
 * @param payload - The raw payload string to sign.
 * @param secret - The shared secret key.
 * @param timestampSeconds - Unix seconds, sent alongside in `TIMESTAMP_HEADER`.
 * @returns `t=<unix>,v1=<hex>`.
 */
export function signPayloadV1(
  payload: string,
  secret: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000)
): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestampSeconds}.${payload}`, 'utf8')
    .digest('hex');
  return `t=${timestampSeconds},${SIGNATURE_VERSION}=${digest}`;
}

/**
 * Sign a payload with the legacy bare-body scheme.
 *
 * @deprecated Prefer {@link signPayloadV1}. The digest here does not cover a
 *   timestamp, so a captured request stays valid for as long as the receiver's
 *   replay window allows after its `X-SecureFlow-Timestamp` header is rewritten.
 *   Kept for senders already configured against it.
 *
 * @param payload - The raw payload string to sign.
 * @param secret - The shared secret key.
 * @returns The signature in `sha256=<hex>` format.
 */
export function signPayload(payload: string, secret: string): string {
  const digest = createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');
  return `${SIGNATURE_PREFIX}${digest}`;
}

/**
 * Parse an `X-SecureFlow-Signature` value in either scheme.
 *
 * Returns `null` for anything malformed. The hex is validated to exactly 64
 * hex characters here rather than left to `Buffer.from(value, 'hex')`, which
 * silently truncates at the first non-hex byte — `v1=zz` would otherwise become
 * a zero-length buffer and reach the comparison.
 */
export function parseSignatureHeader(
  signatureHeader: string | null | undefined
): ParsedSignature | null {
  if (typeof signatureHeader !== 'string') return null;

  const trimmed = signatureHeader.trim();
  if (!trimmed) return null;

  if (trimmed.toLowerCase().startsWith(SIGNATURE_PREFIX)) {
    const hex = normalizeHex(trimmed.slice(SIGNATURE_PREFIX.length));
    return hex ? { scheme: 'legacy', hex } : null;
  }

  // v1: comma-separated `key=value` pairs, order-independent, so a sender that
  // emits `v1=...,t=...` is not rejected over field order.
  const fields = new Map<string, string>();
  for (const segment of trimmed.split(',')) {
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    const value = segment.slice(eq + 1).trim();
    // First occurrence wins: a duplicate `t=` appended by an attacker must not
    // be able to displace the one the digest was computed over.
    if (!fields.has(key)) fields.set(key, value);
  }

  const rawTimestamp = fields.get('t');
  const hex = normalizeHex(fields.get(SIGNATURE_VERSION));
  if (rawTimestamp === undefined || !hex) return null;

  // Integer seconds only. `Number()` would accept '0x10', ' 12 ' and '1e3'.
  if (!/^-?\d+$/.test(rawTimestamp)) return null;

  const timestampSeconds = Number(rawTimestamp);
  if (!Number.isSafeInteger(timestampSeconds)) return null;

  return { scheme: 'v1', hex, timestampSeconds };
}

/** Exactly 64 hex characters, lowercased. `null` for anything else. */
function normalizeHex(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  if (value.length !== SIGNATURE_HEX_LENGTH) return null;
  if (!/^[0-9a-fA-F]+$/.test(value)) return null;
  return value.toLowerCase();
}

/**
 * Verify an HMAC-SHA256 signature with constant-time comparison.
 *
 * Accepts either scheme; the material signed follows from the scheme in the
 * header, so a v1 signature is verified over `` `${t}.${payload}` `` and a
 * legacy one over `payload`.
 *
 * @param payload - The raw payload string that was signed.
 * @param secret - The shared secret key.
 * @param signatureHeader - The full signature header value.
 * @returns `true` if the signature is valid.
 */
export function verifySignature(
  payload: string,
  secret: string,
  signatureHeader: string | null | undefined
): boolean {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;

  return digestMatches(payload, secret, parsed);
}

/** Constant-time comparison of the expected digest against a parsed header. */
function digestMatches(payload: string, secret: string, parsed: ParsedSignature): boolean {
  const material =
    parsed.scheme === 'v1' ? `${parsed.timestampSeconds}.${payload}` : payload;

  const digest = createHmac('sha256', secret).update(material, 'utf8').digest('hex');

  const expected = Buffer.from(parsed.hex, 'hex');
  const provided = Buffer.from(digest, 'hex');

  if (provided.length !== expected.length) return false;

  return timingSafeEqual(provided, expected);
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
 * For a v1 signature there is one extra step: the `t=` the digest was computed
 * over must agree with the `X-SecureFlow-Timestamp` header. Without that check
 * the two schemes collapse into the same weakness — the window would police a
 * header nothing signed.
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
): { ok: true; scheme: 'v1' | 'legacy' } | { ok: false; status: number; message: string } {
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

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    return { ok: false, status: 401, message: 'Invalid signature' };
  }

  // 4. For v1, the signed timestamp and the header must be the same instant.
  if (parsed.scheme === 'v1') {
    const skewSeconds = Math.abs(parsed.timestampSeconds - timestampMs / 1000);
    if (skewSeconds > TIMESTAMP_AGREEMENT_SECONDS) {
      return {
        ok: false,
        status: 401,
        message: 'Signature timestamp does not match timestamp header',
      };
    }
  }

  // 5. Verify signature (constant-time)
  if (!digestMatches(payload, secret, parsed)) {
    return { ok: false, status: 401, message: 'Invalid signature' };
  }

  return { ok: true, scheme: parsed.scheme };
}
