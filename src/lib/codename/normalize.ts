/**
 * Codename normalisation and validation for the Naming Ceremony (#646).
 *
 * The problem this solves is a disagreement between two rules that were both
 * trying to enforce uniqueness and did not mean the same thing:
 *
 *  - **The database** has `codename String? @unique`, a plain Postgres unique
 *    index. Case sensitive.
 *  - **The application** checked with `mode: "insensitive"`.
 *
 * And the formatting sat between them, normalising only *some* input:
 *
 *     const formatted = trimmed.length > 1 && /^[a-zA-Z]+$/.test(trimmed)
 *       ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase()
 *       : trimmed;
 *
 * A single alphabetic word was canonicalised. Everything else — `Tokyo Two`,
 * `agent-007`, `tokyo_two` — was stored exactly as typed. So whether two rows
 * that differ only in case could coexist depended on a query the database was
 * not enforcing, and `Tokyo  Two` (two spaces) was a different codename from
 * `Tokyo Two`, which is precisely the shape an impersonation attempt takes on a
 * public leaderboard.
 *
 * {@link normalizeCodename} makes the rule total: every accepted value has
 * exactly one canonical spelling, so the application check and the database
 * constraint finally agree about what "taken" means.
 */

export const MIN_CODENAME_LENGTH = 2;
export const MAX_CODENAME_LENGTH = 30;

/** Letters, digits, spaces, hyphens and underscores. Unchanged from before. */
const ALLOWED_CHARACTERS = /^[a-zA-Z0-9 _-]+$/;

/**
 * Names nobody may claim.
 *
 * Two groups, for two different reasons. The first is impersonation of the
 * application itself — a leaderboard entry reading `SecureFlow` or `Admin`
 * carries authority it has not earned. The second is the placeholder values a
 * UI falls back to, which would be indistinguishable from a real crew member.
 *
 * Compared on the canonical key, so `secureflow`, `SecureFlow` and `SECURE_FLOW`
 * are all the same reservation.
 */
const RESERVED = [
  'SecureFlow',
  'Secure Flow',
  'Admin',
  'Administrator',
  'Moderator',
  'Support',
  'System',
  'Root',
  'Owner',
  'Staff',
  'Official',
  'The Professor',
  'Professor',
  'Anonymous',
  'Unknown',
  'Deleted User',
  'Deleted',
  'Null',
  'Undefined',
  'None',
];

/**
 * Title-case every alphabetic run in a word.
 *
 * Applied per-run rather than per-word so `agent-007` and `AGENT-007` both land
 * on `Agent-007`. Leaving mixed-character words alone — which is what the old
 * code did — is what let two rows differ by case alone.
 */
function titleCaseRuns(word: string): string {
  return word.replace(/[a-zA-Z]+/g, (run) => run[0].toUpperCase() + run.slice(1).toLowerCase());
}

/**
 * Canonical display form of a codename.
 *
 * Trims, collapses internal whitespace runs to a single space, and applies one
 * casing rule to the whole string. Total: every input has exactly one output,
 * which is what makes the case-sensitive unique index enforce the rule the
 * application claims to enforce.
 */
export function normalizeCodename(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';

  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(titleCaseRuns)
    .join(' ');
}

/**
 * Comparison key for a codename.
 *
 * Lower-cased and with separators removed, so `Tokyo-Two`, `tokyo two` and
 * `TOKYO_TWO` collapse onto one reservation. Used for the reserved-name check;
 * the uniqueness check against other users still runs in the database, because
 * only the database can answer it without a race.
 */
export function codenameKey(value: string): string {
  return normalizeCodename(value).toLowerCase().replace(/[\s_-]/g, '');
}

const RESERVED_KEYS = new Set(RESERVED.map(codenameKey));

/** True when a codename is reserved and may not be claimed by anyone. */
export function isReservedCodename(value: string): boolean {
  return RESERVED_KEYS.has(codenameKey(value));
}

/** The reserved list, for display in the UI. */
export function reservedCodenames(): string[] {
  return [...RESERVED];
}

export type CodenameValidation =
  | { ok: true; codename: string }
  | { ok: false; error: string };

/**
 * Validate and canonicalise a submitted codename.
 *
 * The error strings are the ones the form already renders and the existing
 * tests already assert, so this is a change of implementation rather than of
 * contract.
 */
export function validateCodename(raw: string | null | undefined): CodenameValidation {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';

  if (!trimmed) {
    return { ok: false, error: 'Codename cannot be empty.' };
  }

  // Length is checked on the trimmed input rather than the normalised form so
  // the message matches what the user typed. Normalisation only ever collapses
  // whitespace, so it cannot push a valid value over the ceiling.
  if (trimmed.length < MIN_CODENAME_LENGTH || trimmed.length > MAX_CODENAME_LENGTH) {
    return {
      ok: false,
      error: `Codename must be between ${MIN_CODENAME_LENGTH} and ${MAX_CODENAME_LENGTH} characters long.`,
    };
  }

  if (!ALLOWED_CHARACTERS.test(trimmed)) {
    return {
      ok: false,
      error: 'Codename can only contain letters, numbers, spaces, hyphens, and underscores.',
    };
  }

  const codename = normalizeCodename(trimmed);

  // Possible when the input was all separators: "- -" passes the character
  // check but normalises to something with no substance.
  if (codename.replace(/[\s_-]/g, '').length === 0) {
    return { ok: false, error: 'Codename must contain at least one letter or number.' };
  }

  if (isReservedCodename(codename)) {
    return {
      ok: false,
      error: `Codename "${codename}" is reserved by the operation. Choose another city.`,
    };
  }

  return { ok: true, codename };
}

/** The message shown when a codename belongs to someone else. */
export function codenameTakenError(codename: string): string {
  return `Codename "${codename}" is already taken by an active crew member. Choose another city.`;
}

/**
 * True when a Prisma error is a unique-constraint violation on `codename`.
 *
 * This is the lost half of the race. Two recruits submitting the same codename
 * both see `findFirst` return null, both call `update`, and the second one hits
 * the index. It used to land in the catch-all and be reported as "Failed to
 * secure codename in Vault registry. Please try again." — the worst possible
 * advice, since retrying the same codename fails forever and the user has no
 * way to learn that the fix is to pick a different one.
 *
 * The `target` check is deliberately loose: Prisma reports it as a string array
 * on Postgres but as a string on some other connectors, and a P2002 on this
 * update can only have come from `codename` regardless.
 */
export function isCodenameConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: string }).code !== 'P2002') return false;

  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (target === undefined) return true;

  const fields = Array.isArray(target) ? target : [target];
  return fields.some((field) => String(field).toLowerCase().includes('codename'));
}
