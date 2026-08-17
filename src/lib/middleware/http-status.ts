/**
 * HTTP status normalisation helpers.
 *
 * Errors reaching our global handler come from wildly different places and each
 * library has its own idea of what a "status" is:
 *
 *   • `GenkitError.status`  — a *string* enum ('INVALID_ARGUMENT', 'FAILED_PRECONDITION', …)
 *   • Octokit / fetch       — a real numeric HTTP status
 *   • WebSocket / undici    — close codes such as 1006, or `0` on abort
 *   • Prisma                — no status at all, just `code: 'P2002'`
 *
 * `NextResponse.json(body, { status })` throws a `RangeError` unless `status` is
 * an integer in 200..599, so passing any of those through unchecked turns the
 * error handler itself into the failure. These helpers make that impossible.
 */

/** Lowest status the Response constructor accepts. */
export const MIN_HTTP_STATUS = 200;
/** Highest status the Response constructor accepts. */
export const MAX_HTTP_STATUS = 599;
/** What we fall back to when a value cannot be trusted as a status. */
export const DEFAULT_ERROR_STATUS = 500;

/**
 * Genkit's status enum, mapped onto the HTTP statuses they represent.
 *
 * Genkit models these on Google's canonical gRPC status codes, so the mapping
 * is the standard gRPC → HTTP one. Without this a Genkit failure would collapse
 * to a blanket 500 and the caller would lose the distinction between "you sent
 * something invalid" and "our model backend is down".
 */
const GENKIT_STATUS_TO_HTTP: Record<string, number> = {
  OK: 200,
  CANCELLED: 499,
  UNKNOWN: 500,
  INVALID_ARGUMENT: 400,
  DEADLINE_EXCEEDED: 504,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  PERMISSION_DENIED: 403,
  UNAUTHENTICATED: 401,
  RESOURCE_EXHAUSTED: 429,
  FAILED_PRECONDITION: 400,
  ABORTED: 409,
  OUT_OF_RANGE: 400,
  UNIMPLEMENTED: 501,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  DATA_LOSS: 500,
};

/**
 * Returns `true` when `value` is something `Response` will accept as a status.
 *
 * Deliberately strict: no floats (`404.5`), no `NaN`/`Infinity`, no booleans
 * (`true` would otherwise coerce to `1`), and no out-of-range transport codes.
 */
export function isValidHttpStatus(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_HTTP_STATUS &&
    value <= MAX_HTTP_STATUS
  );
}

/**
 * Interpret a single `status`-ish value, or return `null` when it cannot be
 * understood. Kept separate from `normalizeHttpStatus` so callers that need to
 * try several candidate fields can tell "unusable" apart from "defaulted".
 */
function interpretStatus(value: unknown): number | null {
  if (isValidHttpStatus(value)) return value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;

    // Numeric strings — some HTTP clients stringify the status.
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      return isValidHttpStatus(parsed) ? parsed : null;
    }

    // Named statuses (Genkit / gRPC).
    const mapped = GENKIT_STATUS_TO_HTTP[trimmed.toUpperCase()];
    if (isValidHttpStatus(mapped)) return mapped;
  }

  return null;
}

/**
 * Coerce an arbitrary `status`-ish value into a usable HTTP status.
 *
 * Accepts, in order:
 *   • a valid numeric status                     → itself
 *   • a numeric string ('404')                   → the parsed status
 *   • a Genkit / gRPC status name                → its HTTP equivalent
 *   • anything else (null, 0, 1006, 'boom', {})  → `fallback`
 */
export function normalizeHttpStatus(
  value: unknown,
  fallback: number = DEFAULT_ERROR_STATUS,
): number {
  const safeFallback = isValidHttpStatus(fallback) ? fallback : DEFAULT_ERROR_STATUS;
  return interpretStatus(value) ?? safeFallback;
}

/**
 * Pull a status off an unknown thrown value.
 *
 * Checks `statusCode` before `status` because our own `AppError` uses the
 * former, then falls back to the caller-supplied default. Note that we test
 * each field for *validity* rather than truthiness — the previous
 * `err.statusCode || err.status || 500` chain skipped a perfectly good
 * `statusCode` of `0` only by accident and happily forwarded `1006`.
 */
export function resolveErrorStatus(err: unknown, fallback: number = DEFAULT_ERROR_STATUS): number {
  if (err === null || typeof err !== "object") return fallback;

  const candidate = err as { statusCode?: unknown; status?: unknown };

  for (const raw of [candidate.statusCode, candidate.status]) {
    if (raw === undefined || raw === null) continue;
    const interpreted = interpretStatus(raw);
    if (interpreted !== null) return interpreted;
  }

  return normalizeHttpStatus(fallback, DEFAULT_ERROR_STATUS);
}
