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
 * **legacy.** `sha256=<hex>`. Admitted when the digest is over
 * `` `${timestamp}.${body}` `` (what `signPayload` produces when given a
 * timestamp, and what `signOutboundWebhook` sends). A digest over the bare body
 * is refused by {@link admitWebhookRequest} unless the caller opts in with
 * `allowUnboundLegacySignatures`: it covers no timestamp, so a captured request
 * stays valid forever. Rewriting `X-SecureFlow-Timestamp` to the current time
 * moves it back inside the replay window. Prefer v1.
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

import { createHmac, timingSafeEqual } from "crypto";
import { logger } from "@/lib/logger";

/** Header name used for HMAC-SHA256 signatures. */
export const SIGNATURE_HEADER = "X-SecureFlow-Signature";

/** Header name for the request timestamp (replay protection). */
export const TIMESTAMP_HEADER = "X-SecureFlow-Timestamp";

/**
 * Version tag on the canonical signature header.
 *
 * Must match `SIGNATURE_VERSION` in `src/lib/queue/outbound-dispatch.ts`; the
 * contract test in this module's spec asserts that it does.
 */
export const SIGNATURE_VERSION = "v1";

/** Legacy signature prefix: `sha256=<hex>`. */
const SIGNATURE_PREFIX = "sha256=";

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

/**
 * A request body as it is verified. Bytes are used exactly as received; a
 * string stands for its UTF-8 encoding.
 */
export type SignedPayload = string | Uint8Array;

/** Hex HMAC-SHA256 over `prefix` followed by the payload. */
function hmacHex(secret: string, prefix: string, payload: SignedPayload): string {
  const hmac = createHmac("sha256", secret).update(prefix, "utf8");
  if (typeof payload === "string") hmac.update(payload, "utf8");
  else hmac.update(payload);
  return hmac.digest("hex");
}

/** A parsed `X-SecureFlow-Signature` value. */
export type ParsedSignature =
  { scheme: "v1"; hex: string; timestampSeconds: number } | { scheme: "legacy"; hex: string };

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
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${payload}`, "utf8")
    .digest("hex");
  return `t=${timestampSeconds},${SIGNATURE_VERSION}=${digest}`;
}

/**
 * Sign a payload with the legacy scheme.
 *
 * @deprecated Prefer {@link signPayloadV1}. When called without
 *   `timestampSeconds`, the digest does not cover a timestamp, so a captured
 *   request stays valid for as long as the receiver's replay window allows
 *   after its `X-SecureFlow-Timestamp` header is rewritten. Kept for senders
 *   already configured against it.
 *
 * @param payload - The raw payload string to sign.
 * @param secret - The shared secret key.
 * @param timestampSeconds - Optional Unix seconds to bind into the legacy digest.
 * @returns The signature in `sha256=<hex>` format.
 */
export function signPayload(
  payload: string,
  secret: string,
  timestampSeconds?: number | string,
): string {
  const material =
    timestampSeconds !== undefined &&
    timestampSeconds !== null &&
    String(timestampSeconds).trim() !== ""
      ? `${timestampSeconds}.${payload}`
      : payload;
  const digest = createHmac("sha256", secret).update(material, "utf8").digest("hex");
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
  signatureHeader: string | null | undefined,
): ParsedSignature | null {
  if (typeof signatureHeader !== "string") return null;

  const trimmed = signatureHeader.trim();
  if (!trimmed) return null;

  if (trimmed.toLowerCase().startsWith(SIGNATURE_PREFIX)) {
    const hex = normalizeHex(trimmed.slice(SIGNATURE_PREFIX.length));
    return hex ? { scheme: "legacy", hex } : null;
  }

  // v1: comma-separated `key=value` pairs, order-independent, so a sender that
  // emits `v1=...,t=...` is not rejected over field order.
  const fields = new Map<string, string>();
  for (const segment of trimmed.split(",")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    const value = segment.slice(eq + 1).trim();
    // First occurrence wins: a duplicate `t=` appended by an attacker must not
    // be able to displace the one the digest was computed over.
    if (!fields.has(key)) fields.set(key, value);
  }

  const rawTimestamp = fields.get("t");
  const hex = normalizeHex(fields.get(SIGNATURE_VERSION));
  if (rawTimestamp === undefined || !hex) return null;

  // Integer seconds only. `Number()` would accept '0x10', ' 12 ' and '1e3'.
  if (!/^-?\d+$/.test(rawTimestamp)) return null;

  const timestampSeconds = Number(rawTimestamp);
  if (!Number.isSafeInteger(timestampSeconds)) return null;

  return { scheme: "v1", hex, timestampSeconds };
}

/** Exactly 64 hex characters, lowercased. `null` for anything else. */
function normalizeHex(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  if (value.length !== SIGNATURE_HEX_LENGTH) return null;
  if (!/^[0-9a-fA-F]+$/.test(value)) return null;
  return value.toLowerCase();
}

/**
 * Verify an HMAC-SHA256 signature with constant-time comparison.
 *
 * Accepts either scheme; the material signed follows from the scheme in the
 * header, so a v1 signature is verified over `` `${t}.${payload}` `` and a
 * legacy one over `` `${t}.${payload}` `` (or `payload` as fallback).
 *
 * This answers "was this signed with the secret", nothing more. It applies no
 * replay window and accepts an unbound legacy digest, so it is not an
 * admission check: inbound requests go through {@link admitWebhookRequest}.
 *
 * @param payload - The raw payload string that was signed.
 * @param secret - The shared secret key.
 * @param signatureHeader - The full signature header value.
 * @param timestampHeader - Optional timestamp header value.
 * @returns `true` if the signature is valid.
 */
export function verifySignature(
  payload: SignedPayload,
  secret: string,
  signatureHeader: string | null | undefined,
  timestampHeader?: string | null | undefined,
): boolean {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;

  const timestampMs = parseTimestamp(timestampHeader);
  const timestampSeconds = timestampMs !== null ? Math.floor(timestampMs / 1000) : undefined;

  return digestMatches(payload, secret, parsed, timestampSeconds);
}

/** Constant-time comparison of a computed hex digest against the header's. */
function hexDigestEquals(computed: string, provided: string): boolean {
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(provided, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Which digest a header matched, or `null` for none.
 *
 * `"unbound"` means a legacy digest over the bare body: valid as a signature,
 * but tied to no timestamp. Admission decides whether that is acceptable.
 */
function matchDigest(
  payload: SignedPayload,
  secret: string,
  parsed: ParsedSignature,
  timestampSeconds?: number,
): "v1" | "bound" | "unbound" | null {
  if (parsed.scheme === "v1") {
    return hexDigestEquals(hmacHex(secret, `${parsed.timestampSeconds}.`, payload), parsed.hex)
      ? "v1"
      : null;
  }

  if (
    timestampSeconds !== undefined &&
    hexDigestEquals(hmacHex(secret, `${timestampSeconds}.`, payload), parsed.hex)
  ) {
    return "bound";
  }

  return hexDigestEquals(hmacHex(secret, "", payload), parsed.hex) ? "unbound" : null;
}

/** Constant-time comparison of the expected digest against a parsed header. */
function digestMatches(
  payload: SignedPayload,
  secret: string,
  parsed: ParsedSignature,
  timestampSeconds?: number,
): boolean {
  return matchDigest(payload, secret, parsed, timestampSeconds) !== null;
}

/**
 * Parse a timestamp from the `X-SecureFlow-Timestamp` header.
 *
 * @param timestampHeader - The raw header value (Unix epoch seconds as string).
 * @returns The parsed timestamp in milliseconds, or `null` if invalid.
 */
export function parseTimestamp(timestampHeader: string | null | undefined): number | null {
  if (typeof timestampHeader !== "string") return null;

  const trimmed = timestampHeader.trim();
  if (!trimmed) return null;

  // Integer seconds only, matching the signed `t=` field parser above:
  // Number() would accept '0x10', '1e3' and '12.5' — and the header and the
  // signed field are supposed to be the same number under the same rules.
  if (!/^-?\d+$/.test(trimmed)) return null;

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return null;

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
  toleranceSeconds: number = DEFAULT_REPLAY_WINDOW_SECONDS,
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
 * @param payload - The raw request body. Pass the bytes as received where
 *   possible; a string is verified as its UTF-8 encoding.
 * @param secret - The shared HMAC secret.
 * @param signatureHeader - The `X-SecureFlow-Signature` header value.
 * @param timestampHeader - The `X-SecureFlow-Timestamp` header value.
 * @param replayWindowSeconds - Maximum allowed age (default: 300).
 * @param options.allowUnboundLegacySignatures - Also admit a legacy digest over
 *   the bare body. Off by default: such a signature covers no timestamp, so a
 *   captured request can be replayed indefinitely by refreshing the timestamp
 *   header. For senders that have not yet moved to v1 or a timestamp-bound
 *   legacy digest.
 * @returns An admission result with `ok: true` or an error message.
 */
export function admitWebhookRequest(
  payload: SignedPayload,
  secret: string,
  signatureHeader: string | null | undefined,
  timestampHeader: string | null | undefined,
  replayWindowSeconds: number = DEFAULT_REPLAY_WINDOW_SECONDS,
  options: { allowUnboundLegacySignatures?: boolean } = {},
): { ok: true; scheme: "v1" | "legacy" } | { ok: false; status: number; message: string } {
  // 1. Signature required
  if (!signatureHeader) {
    return { ok: false, status: 401, message: "Missing signature header" };
  }

  // 2. Timestamp required for replay protection
  if (!timestampHeader) {
    return { ok: false, status: 401, message: "Missing timestamp header" };
  }

  const timestampMs = parseTimestamp(timestampHeader);
  if (timestampMs === null) {
    return { ok: false, status: 400, message: "Invalid timestamp format" };
  }

  // 3. Check replay window (reject old requests)
  if (!isWithinReplayWindow(timestampMs, replayWindowSeconds)) {
    return { ok: false, status: 401, message: "Request timestamp outside allowed window" };
  }

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    return { ok: false, status: 401, message: "Invalid signature" };
  }

  // 4. For v1, the signed timestamp and the header must be the same instant.
  if (parsed.scheme === "v1") {
    const skewSeconds = Math.abs(parsed.timestampSeconds - timestampMs / 1000);
    if (skewSeconds > TIMESTAMP_AGREEMENT_SECONDS) {
      return {
        ok: false,
        status: 401,
        message: "Signature timestamp does not match timestamp header",
      };
    }
  }

  // 5. Verify signature (constant-time)
  const timestampSeconds = Math.floor(timestampMs / 1000);
  const matched = matchDigest(payload, secret, parsed, timestampSeconds);
  if (!matched) {
    return { ok: false, status: 401, message: "Invalid signature" };
  }

  // 6. A bare-body legacy digest signs no timestamp. The window in step 3
  //    checked a header nothing authenticated, so this could be a replay of
  //    any delivery ever captured.
  if (matched === "unbound" && !options.allowUnboundLegacySignatures) {
    return {
      ok: false,
      status: 401,
      message: "Signature does not cover the request timestamp",
    };
  }

  // 7. The opt-in admitted a signature that covers no timestamp. Say so on
  //    every such request, so operators can find the senders that still need
  //    to move to v1 before the opt-in is removed. Metadata only: never log
  //    the payload, secret or signature.
  if (matched === "unbound") {
    logger.warn(
      "[WEBHOOK_DEPRECATION] Accepted a legacy signature that does not cover the timestamp " +
        "(WEBHOOK_ALLOW_UNBOUND_LEGACY_SIGNATURES=true). Replay protection is weakened for this " +
        "request; migrate the sender to the v1 signature format.",
      { scheme: "legacy", bound: false },
    );
  }

  return { ok: true, scheme: parsed.scheme };
}
