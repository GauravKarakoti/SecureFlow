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
 * Normalise a metadata key for sensitive-key matching: lowercase, with
 * separators squashed out, so `API_KEY`, `api-key` and `Api Key` all collapse
 * onto the same lookup value.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

/**
 * Keys whose values should be redacted entirely when found in metadata objects.
 * Checked case-insensitively and ignoring separators.
 *
 * The list is written in its readable form and normalised once at module load.
 * Previously the raw strings were compared against an already-normalised key,
 * so every underscored entry (`api_key`, `access_token`, `private_key`, …) was
 * dead weight that could never match — each happened to have a squashed twin,
 * but the next entry added in that style would have silently done nothing.
 */
const REDACTED_KEYS = new Set(
  [
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "access_token",
    "refresh_token",
    "client_secret",
    "private_key",
    "authorization",
    "cookie",
    "session",
    "credential",
    "credentials",
    "webhook_secret",
    "github_token",
  ].map(normalizeKey),
);

/**
 * Caps on how much of a single metadata payload we persist. An audit row is
 * evidence, not a dump: without these one oversized job payload can bloat the
 * `AuditLog` table and slow every query against it.
 */
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_LENGTH = 4096;
const MAX_DEPTH = 8;

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
  return sanitizeValue(metadata, depth, new WeakSet<object>());
}

/**
 * Sanitise a single string value: fingerprints pass through untouched, secrets
 * are redacted, emails masked, and anything absurdly long is truncated.
 */
function sanitizeString(value: string): string {
  // Pure hex strings are SHA-256 fingerprints or similar identifiers — do NOT
  // redact them, but they are still subject to the length cap below.
  const cleaned = isPureHex(value) ? value : maskSecretValue(value);

  // Simple heuristic for detecting email strings.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
    return maskEmail(cleaned);
  }

  if (cleaned.length > MAX_STRING_LENGTH) {
    return `${cleaned.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]`;
  }

  return cleaned;
}

/**
 * The real recursion. `seen` tracks the objects on the current walk so a
 * circular reference is reported once instead of being re-expanded at every
 * level until the depth cap bails out.
 */
function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  // Prevent accidental infinite recursion on deeply nested (or circular) data.
  if (depth > MAX_DEPTH) return "[TRUNCATED]";

  if (value === null || value === undefined) return value;

  if (typeof value === "boolean") return value;

  if (typeof value === "number") {
    // NaN / Infinity are not representable in JSON and become null on write.
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "string") return sanitizeString(value);

  if (typeof value === "bigint") return `${value.toString()}n`;

  if (typeof value === "symbol") return value.toString();

  if (typeof value === "function") {
    return `[Function${value.name ? `: ${value.name}` : ""}]`;
  }

  // ── Built-ins that carry their data in internal slots ────────────────────
  //
  // Everything below reaches the generic object branch as `typeof === "object"`
  // but has no own enumerable properties, so `Object.entries()` returns `[]`
  // and the value would serialise to `{}` — silently destroying the evidence
  // the audit row exists to capture.

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "[Invalid Date]" : value.toISOString();
  }

  if (value instanceof RegExp) return value.toString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message ?? ""),
    };
  }

  if (value instanceof URL) {
    // Credentials can live in the userinfo component of a URL.
    const cloned = new URL(value.href);
    if (cloned.username || cloned.password) {
      cloned.username = "";
      cloned.password = "";
      return `${cloned.href} [CREDENTIALS_REDACTED]`;
    }
    return sanitizeString(cloned.href);
  }

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    // Buffers/TypedArrays would otherwise expand into a per-byte object like
    // { "0": 104, "1": 105, … }, which is both useless and unbounded.
    return `[Binary: ${value.byteLength} bytes]`;
  }

  // ── Containers ───────────────────────────────────────────────────────────

  if (typeof value === "object") {
    if (seen.has(value as object)) return "[CIRCULAR]";
    seen.add(value as object);

    try {
      if (value instanceof Map) {
        const entries: Record<string, unknown> = {};
        let count = 0;
        for (const [rawKey, rawValue] of value.entries()) {
          if (count >= MAX_OBJECT_KEYS) {
            entries["[TRUNCATED]"] = `${value.size - MAX_OBJECT_KEYS} more entries`;
            break;
          }
          const key = String(rawKey);
          entries[key] = REDACTED_KEYS.has(normalizeKey(key))
            ? "[REDACTED]"
            : sanitizeValue(rawValue, depth + 1, seen);
          count += 1;
        }
        return entries;
      }

      if (value instanceof Set) {
        const items = Array.from(value.values(), (item) => sanitizeValue(item, depth + 1, seen));
        return items.length > MAX_ARRAY_ITEMS
          ? [
              ...items.slice(0, MAX_ARRAY_ITEMS),
              `[TRUNCATED: ${items.length - MAX_ARRAY_ITEMS} more]`,
            ]
          : items;
      }

      if (Array.isArray(value)) {
        const items = value
          .slice(0, MAX_ARRAY_ITEMS)
          .map((item) => sanitizeValue(item, depth + 1, seen));
        return value.length > MAX_ARRAY_ITEMS
          ? [...items, `[TRUNCATED: ${value.length - MAX_ARRAY_ITEMS} more]`]
          : items;
      }

      const sanitized: Record<string, unknown> = {};
      const allEntries = Object.entries(value as Record<string, unknown>);

      for (const [key, entryValue] of allEntries.slice(0, MAX_OBJECT_KEYS)) {
        sanitized[key] = REDACTED_KEYS.has(normalizeKey(key))
          ? "[REDACTED]"
          : sanitizeValue(entryValue, depth + 1, seen);
      }

      if (allEntries.length > MAX_OBJECT_KEYS) {
        sanitized["[TRUNCATED]"] = `${allEntries.length - MAX_OBJECT_KEYS} more keys`;
      }

      return sanitized;
    } finally {
      // Only the *current* path matters: two sibling references to the same
      // object are not a cycle and should both be expanded.
      seen.delete(value as object);
    }
  }

  // Fallback for anything genuinely unknown.
  return String(value);
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
