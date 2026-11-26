import crypto from "node:crypto";

/**
 * Zero-Downtime Dual-Key HMAC Secret Rotation with Time-Bounded Grace Windows (#2109).
 */

export const OUTBOUND_KEY_ID_HEADER = "X-SecureFlow-Key-Id";
export const OUTBOUND_PREVIOUS_SIGNATURE_HEADER = "X-SecureFlow-Signature-Previous";
export const DEFAULT_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface RotatingSecretConfig {
  primarySecret: string;
  primaryKeyId?: string;
  previousSecret?: string | null;
  previousKeyId?: string | null;
  rotationGraceUntil?: Date | number | string | null;
}

export interface RotationVerificationResult {
  valid: boolean;
  matchedKey: "primary" | "previous" | "none";
  matchedKeyId?: string;
  graceExpired: boolean;
  reason?: string;
}

function parseEpochMs(value: Date | number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Constant-time comparison of two UTF-8 signature strings.
 */
export function constantTimeSignatureEqual(provided: string, expected: string): boolean {
  const bufA = Buffer.from(provided.trim(), "utf8");
  const bufB = Buffer.from(expected.trim(), "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Computes a `sha256=<hex>` HMAC signature for a payload and secret.
 */
export function computeHmacSha256Header(payload: string | Uint8Array, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${hmac}`;
}

/**
 * Generates a new cryptographically random key ID.
 */
export function generateWebhookKeyId(): string {
  return `kid_${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Transitions an active webhook secret into `previousSecret` with a time-bounded
 * grace window and generates a fresh `primarySecret`.
 */
export function createRotationTransition(
  currentSecret: string,
  currentKeyId?: string,
  graceWindowMs: number = DEFAULT_ROTATION_GRACE_MS,
  now: number = Date.now(),
): RotatingSecretConfig {
  const nextSecret = `whsec_${crypto.randomBytes(32).toString("hex")}`;
  return {
    primarySecret: nextSecret,
    primaryKeyId: generateWebhookKeyId(),
    previousSecret: currentSecret,
    previousKeyId: currentKeyId ?? "legacy",
    rotationGraceUntil: new Date(now + Math.max(0, graceWindowMs)),
  };
}

/**
 * Returns true if `previousSecret` is configured and `now` is within `rotationGraceUntil`.
 */
export function isGraceWindowActive(
  config: RotatingSecretConfig,
  now: number = Date.now(),
): boolean {
  if (!config.previousSecret || config.previousSecret.trim() === "") {
    return false;
  }
  const graceUntilMs = parseEpochMs(config.rotationGraceUntil);
  if (graceUntilMs === null) {
    return false;
  }
  return now <= graceUntilMs;
}

/**
 * Builds outbound webhook signature headers, including `X-SecureFlow-Signature-Previous`
 * when a rotation grace window is active.
 */
export function buildDualSignatureHeaders(
  payload: string | Uint8Array,
  config: RotatingSecretConfig,
  now: number = Date.now(),
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-SecureFlow-Signature": computeHmacSha256Header(payload, config.primarySecret),
  };

  if (config.primaryKeyId) {
    headers[OUTBOUND_KEY_ID_HEADER] = config.primaryKeyId;
  }

  if (isGraceWindowActive(config, now) && config.previousSecret) {
    headers[OUTBOUND_PREVIOUS_SIGNATURE_HEADER] = computeHmacSha256Header(
      payload,
      config.previousSecret,
    );
  }

  return headers;
}

/**
 * Verifies an HMAC signature against `primarySecret` first, falling back to
 * `previousSecret` only while `now <= rotationGraceUntil`.
 */
export function verifyWithRotationGrace(
  payload: string | Uint8Array,
  signatureHeader: string,
  config: RotatingSecretConfig,
  now: number = Date.now(),
): RotationVerificationResult {
  if (!signatureHeader || typeof signatureHeader !== "string") {
    return {
      valid: false,
      matchedKey: "none",
      graceExpired: false,
      reason: "Missing or invalid signature header.",
    };
  }

  const expectedPrimary = computeHmacSha256Header(payload, config.primarySecret);
  if (constantTimeSignatureEqual(signatureHeader, expectedPrimary)) {
    return {
      valid: true,
      matchedKey: "primary",
      matchedKeyId: config.primaryKeyId,
      graceExpired: false,
    };
  }

  if (config.previousSecret && config.previousSecret.trim() !== "") {
    const graceUntilMs = parseEpochMs(config.rotationGraceUntil);
    const expectedPrevious = computeHmacSha256Header(payload, config.previousSecret);
    const matchesPrevious = constantTimeSignatureEqual(signatureHeader, expectedPrevious);

    if (graceUntilMs !== null && now <= graceUntilMs) {
      if (matchesPrevious) {
        return {
          valid: true,
          matchedKey: "previous",
          matchedKeyId: config.previousKeyId ?? undefined,
          graceExpired: false,
        };
      }
    } else if (matchesPrevious) {
      return {
        valid: false,
        matchedKey: "none",
        graceExpired: true,
        reason: "Signature matched expired previous secret outside rotation grace window.",
      };
    }
  }

  return {
    valid: false,
    matchedKey: "none",
    graceExpired: false,
    reason: "Signature mismatch.",
  };
}
