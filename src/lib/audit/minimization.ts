import { createHash } from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
//  Audit Log Data Minimization Utilities
//
//  These helpers address Issue #404 — ensuring that sensitive data flowing
//  through the system is masked, hashed, or omitted before being persisted
//  to the AuditLog table.
//
//  Design principles:
//    • Mask rather than drop: preserve enough context for forensic analysis
//      without exposing the full sensitive value.
//    • Deterministic hashing for entity identifiers (e.g., user IDs) so that
//      cross-log correlation remains possible without leaking raw IDs.
//    • Recursive metadata sanitisation so nested payloads are also cleaned.
//    • All helpers are pure functions — no side effects — to keep the module
//      easily testable and composable.
// ─────────────────────────────────────────────────────────────────────────────

// ── Sensitive key patterns ────────────────────────────────────────────────────

/**
 * Keys whose values should be redacted entirely when found in metadata objects.
 * Checked case-insensitively.
 */
const REDACTED_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "client_secret",
  "clientsecret",
  "private_key",
  "privatekey",
  "authorization",
  "cookie",
  "session",
  "credential",
  "credentials",
  "webhook_secret",
  "webhooksecret",
  "github_token",
  "githubtoken",
]);

/**
 * Pattern matching common secret value shapes (API keys, JWTs, Bearer tokens,
 * base64-encoded credentials, etc.) so they can be redacted even when found
 * under a non-sensitive key name.
 *
 * Deliberately excludes pure lowercase-hex strings (e.g. SHA-256 fingerprints
 * like `abc123def456...`) so that audit metadata containing content fingerprints
 * is not incorrectly redacted.
 */
const SECRET_VALUE_PATTERN =
  /(?:Bearer\s+[\w\-._~+/]+=*|eyJ[\w\-._~+/]+=*\.[^\s]{10,}|(?:sk|pk|ghp|gho|ghu|ghs|ghr|glpat|xox[a-z]-)[_\-A-Za-z0-9]{16,}|[A-Za-z0-9+/]{40,}={0,2})/gi;

/** Returns true when the entire string is a pure lowercase hex sequence (e.g. a SHA-256 fingerprint). */
function isPureHex(value: string): boolean {
  return /^[0-9a-f]+$/i.test(value);
}

// ── Email masking ─────────────────────────────────────────────────────────────

/**
 * Masks an email address so that only the first and last character of the
 * local part are retained, e.g.:
 *   "admin@secureflow.test"  →  "a***n@secureflow.test"
 *   "a@example.com"          →  "a***@example.com"
 *
 * If the input is not a recognisable email, the raw value is returned
 * unchanged so that legitimate non-email strings in `resource` fields
 * are not distorted.
 */
export function maskEmail(email: string): string {
  if (!email || typeof email !== "string") return email;

  const atIndex = email.lastIndexOf("@");
  if (atIndex <= 0) return email; // Not a valid email — leave as-is.

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex); // includes '@'

  if (local.length <= 1) {
    return `${local}***${domain}`;
  }

  const first = local[0];
  const last = local[local.length - 1];
  return `${first}***${last}${domain}`;
}

// ── Secret / token detection ──────────────────────────────────────────────────

/**
 * Returns `true` when the provided string value looks like a secret:
 * a JWT, Bearer token, GitHub personal-access token, long base64 blob, etc.
 */
export function looksLikeSecret(value: string): boolean {
  if (typeof value !== "string" || value.length < 16) return false;
  SECRET_VALUE_PATTERN.lastIndex = 0; // Reset stateful RegExp before testing.
  return SECRET_VALUE_PATTERN.test(value);
}

/**
 * Replaces all secret-shaped substrings inside `value` with `[REDACTED]`.
 * Safe to call on plain strings or serialised JSON.
 */
export function maskSecretValue(value: string): string {
  if (!value || typeof value !== "string") return value;
  SECRET_VALUE_PATTERN.lastIndex = 0;
  return value.replace(SECRET_VALUE_PATTERN, "[REDACTED]");
}

// ── SHA-256 fingerprinting ────────────────────────────────────────────────────

/**
 * Returns the first 12 hex characters of the SHA-256 hash of `raw`.
 * Useful for logging entity identifiers (user IDs, delivery IDs) in a way
 * that is:
 *   • Consistent — the same input always produces the same hash.
 *   • Non-reversible — the raw value cannot be recovered from the hash alone.
 *   • Distinct — collisions at 12 characters are astronomically unlikely.
 *
 * A `prefix` can be provided to make the output self-documenting, e.g.:
 *   hashIdentifier("user-abc-123", "usr")  →  "usr:3d9f2a1e4b8c"
 */
export function hashIdentifier(raw: string, prefix?: string): string {
  if (!raw || typeof raw !== "string") return raw;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return prefix ? `${prefix}:${hash}` : hash;
}

// ── Metadata recursion ────────────────────────────────────────────────────────

/**
 * Recursively walks an arbitrary object or array that is destined for the
 * `metadata` column of an AuditLog row and:
 *
 *   1. Redacts any key that matches the `REDACTED_KEYS` set (case-insensitive).
 *   2. Replaces string values that look like secrets with `[REDACTED]`.
 *   3. Replaces email strings with their masked equivalents.
 *   4. Passes numbers, booleans, and `null` through unchanged.
 *
 * The function is non-destructive — it returns a new object/array rather than
 * mutating the original.
 */
export function sanitizeAuditMetadata(metadata: unknown, depth = 0): unknown {
  // Prevent accidental infinite recursion on deeply nested (or circular) data.
  if (depth > 8) return "[TRUNCATED]";

  if (metadata === null || metadata === undefined) return metadata;
  if (typeof metadata === "boolean" || typeof metadata === "number") {
    return metadata;
  }

  if (typeof metadata === "string") {
    // Pure hex strings are SHA-256 fingerprints or similar identifiers — do NOT redact.
    if (isPureHex(metadata)) return metadata;
    // Replace secret-shaped strings first, then check for emails.
    const afterSecret = maskSecretValue(metadata);
    // Simple heuristic for detecting email strings.
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(afterSecret)) {
      return maskEmail(afterSecret);
    }
    return afterSecret;
  }

  if (Array.isArray(metadata)) {
    return metadata.map((item) => sanitizeAuditMetadata(item, depth + 1));
  }

  if (typeof metadata === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
      const keyLower = key.toLowerCase().replace(/[-_\s]/g, "");
      if (REDACTED_KEYS.has(keyLower)) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = sanitizeAuditMetadata(value, depth + 1);
      }
    }
    return sanitized;
  }

  // Fallback: convert unknown types (BigInt, Symbol, etc.) to a safe string.
  return String(metadata);
}

// ── Top-level audit log input sanitiser ──────────────────────────────────────

export interface AuditLogInput {
  userId?: string | null;
  action: string;
  resource?: string | null;
  decision?: string | null;
  metadata?: Record<string, unknown> | unknown | null;
}

/**
 * Sanitises a complete AuditLog payload before it is passed to
 * `prisma.auditLog.create()`.
 *
 * Rules applied per field:
 *   • `userId`    — SHA-256 fingerprinted (logged as a short hash, not raw ID).
 *                   The original value is still written since Prisma needs the
 *                   actual FK; this function is for the *data* portions only.
 *                   We therefore leave `userId` untouched here and let
 *                   callers decide whether to hash it in the metadata.
 *   • `action`    — Trimmed and uppercased; no sensitive data expected here.
 *   • `resource`  — Email addresses within the resource string are masked;
 *                   secret patterns are redacted.
 *   • `decision`  — Passed through (values like "ALLOW", "BLOCK", "ADMIN").
 *   • `metadata`  — Fully sanitised via `sanitizeAuditMetadata()`.
 */
export function sanitizeAuditLogInput(input: AuditLogInput): AuditLogInput {
  const sanitized: AuditLogInput = {
    userId: input.userId,
    action: (input.action ?? "").trim().toUpperCase(),
    resource: input.resource ? maskSecretValue(
      // Mask emails embedded in resource strings like "user:admin@example.com"
      input.resource.replace(
        /[^\s@]+@[^\s@]+\.[^\s@]+/g,
        (email) => maskEmail(email)
      )
    ) : input.resource,
    decision: input.decision,
    metadata: input.metadata != null
      ? sanitizeAuditMetadata(input.metadata) as Record<string, unknown>
      : input.metadata,
  };

  return sanitized;
}
