import crypto from "node:crypto";

/**
 * Outbound Webhook HMAC-SHA256 Signature & Replay Protection (#1866).
 *
 * Each webhook endpoint has an independent cryptographic secret generated
 * upon registration (`whsec_<hex>`).
 *
 * For each delivery:
 * 1. An event ID (`evt_<uuid>`) and ISO timestamp are generated.
 * 2. An HMAC-SHA256 hex digest is computed over the payload.
 * 3. `X-SecureFlow-Signature`, `X-SecureFlow-Event-Id`, and `X-SecureFlow-Timestamp`
 *    headers are attached to the request.
 */

export const OUTBOUND_SIGNATURE_HEADER = "X-SecureFlow-Signature";
export const OUTBOUND_EVENT_HEADER = "X-SecureFlow-Event";
export const OUTBOUND_EVENT_ID_HEADER = "X-SecureFlow-Event-Id";
export const OUTBOUND_TIMESTAMP_HEADER = "X-SecureFlow-Timestamp";

/**
 * Generate a cryptographically secure endpoint secret.
 */
export function generateOutboundWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString("hex")}`;
}

/**
 * Compute the HMAC-SHA256 signature for a payload.
 * Returns `sha256=<hex-digest>`.
 */
export function computeOutboundWebhookSignature(payload: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${hmac}`;
}

export interface VerifySignatureOptions {
  payload: string;
  signature: string;
  secret: string;
  timestamp?: string | number | null;
  toleranceSeconds?: number;
}

/**
 * Verify an incoming webhook signature using constant-time comparison,
 * with optional replay protection check on timestamp.
 */
export function verifyOutboundWebhookSignature({
  payload,
  signature,
  secret,
  timestamp,
  toleranceSeconds = 300, // 5 minutes default replay window
}: VerifySignatureOptions): { valid: boolean; reason?: string } {
  if (!signature || typeof signature !== "string") {
    return { valid: false, reason: "Missing or invalid signature header." };
  }

  // Replay window check if timestamp is provided
  if (timestamp) {
    const eventTimeMs = typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime();
    if (Number.isNaN(eventTimeMs)) {
      return { valid: false, reason: "Invalid timestamp format." };
    }
    const currentTimeMs = Date.now();
    const ageSeconds = Math.abs((currentTimeMs - eventTimeMs) / 1000);
    if (ageSeconds > toleranceSeconds) {
      return { valid: false, reason: `Timestamp outside tolerance window (${ageSeconds.toFixed(1)}s > ${toleranceSeconds}s).` };
    }
  }

  const expectedSignature = computeOutboundWebhookSignature(payload, secret);

  const cleanProvided = signature.trim();
  const cleanExpected = expectedSignature.trim();

  const providedBuf = Buffer.from(cleanProvided);
  const expectedBuf = Buffer.from(cleanExpected);

  if (providedBuf.length !== expectedBuf.length) {
    return { valid: false, reason: "Signature length mismatch." };
  }

  const isValid = crypto.timingSafeEqual(providedBuf, expectedBuf);
  return { valid: isValid, reason: isValid ? undefined : "Signature mismatch." };
}
