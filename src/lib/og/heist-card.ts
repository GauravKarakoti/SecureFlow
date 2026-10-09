/**
 * Parameter validation for the heist share card (#687).
 *
 * `/api/og/heist` is public, unauthenticated, and renders a 1200x630 image with
 * Satori. Every value it draws comes out of the query string. Most of them were
 * already trimmed and length-capped in the route handler — `project` to 60
 * characters, `alias` and `stolen` to 30 — but the capping was inline, ad hoc,
 * and applied to some parameters and not others:
 *
 *  - **`timestamp` had no bound at all.** It went from `searchParams.get()`
 *    straight into the JSX, so a caller could hand Satori an arbitrarily long
 *    string to lay out inside a fixed frame. The route's rate limit bounds how
 *    many requests a caller makes, not what each one costs.
 *  - **`findingsCount` was checked with `!Number.isNaN(Number(raw))`**, which is
 *    true for the empty string (`Number('') === 0`), for `Infinity`, and for
 *    `1e21`. `?findings=` rendered "Findings Logged: 0" and `?findings=1e21`
 *    rendered `1e+21`.
 *
 * Pulling it out of the route buys two things beyond consistency. It is
 * testable without standing up a Next request, and it puts the caching decision
 * next to the thing that decides it — see {@link cacheControlFor}.
 */

/** Frame the card is rendered into. Here so the caps below have a reason. */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/** Per-field character caps. The first three match the route's previous inline slices. */
export const MAX_PROJECT_LENGTH = 60;
export const MAX_ALIAS_LENGTH = 30;
export const MAX_STOLEN_LENGTH = 30;

/**
 * Cap on the timestamp.
 *
 * The default this replaces is produced by `toLocaleString('en-US', {
 * dateStyle: 'medium', timeStyle: 'short' })` — "Aug 27, 2026, 10:15 PM", 22
 * characters. 40 leaves room for a longer locale rendering without leaving the
 * field unbounded, which is what it was.
 */
export const MAX_TIMESTAMP_LENGTH = 40;

/** Ceiling on the findings counter, above which the number stops being readable. */
export const MAX_FINDINGS_COUNT = 1_000_000;

/** Ranks the badge renders. Anything else is omitted rather than drawn. */
export const VALID_RANKS = ["S", "A", "B", "C", "D"] as const;
export type CardRank = (typeof VALID_RANKS)[number];

export const DEFAULT_PROJECT = "Classified Target";
export const DEFAULT_ALIAS = "The Professor";
export const DEFAULT_SCORE = 100;

export type CardTheme = "heist" | "glitch";

export interface HeistCardParams {
  project: string;
  alias: string;
  /** Integer 0-100. */
  score: number;
  rank?: CardRank;
  /** Present only when a valid non-negative integer was supplied. */
  findingsCount?: string;
  stolen?: string;
  theme: CardTheme;
  timestamp: string;
  /**
   * True when the caller supplied a usable `timestamp`, so the rendered bytes
   * are a pure function of the URL. Drives {@link cacheControlFor}.
   */
  timestampPinned: boolean;
}

/**
 * Strip anything that is not printable text.
 *
 * Satori lays out whatever it is given; a NUL or a bidi override in a project
 * name will not render as anything a reader can interpret, and the zero-width
 * characters are the standard way to make one string look like another.
 * Newlines go too — the card's fields are single-line by design.
 */
function stripControlCharacters(value: string): string {
  return (
    value
      // C0 and C1 control characters, including the newlines the layout has no row for.
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
      // Zero-width, soft hyphen, and the bidi overrides.
      .replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Clean and cap a free-text field.
 *
 * The cap is applied after cleaning, so stripped characters do not consume
 * budget and a string of 200 zero-width characters is empty rather than a
 * full-length blank.
 */
export function sanitizeText(raw: string | null | undefined, maxLength: number): string {
  if (typeof raw !== "string") return "";
  return stripControlCharacters(raw).slice(0, maxLength);
}

/**
 * Parse the security score into an integer in `0..100`.
 *
 * Non-numeric input falls back to the default rather than to `NaN`, which
 * `.toString()` would happily render as "NaN" in 86px type.
 */
export function parseScore(raw: string | null | undefined): number {
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_SCORE;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_SCORE;

  return Math.max(0, Math.min(100, Math.round(parsed)));
}

/**
 * Parse the findings counter, or `undefined` when there is nothing to draw.
 *
 * `Number.isFinite` rather than `!Number.isNaN`: the latter accepts `Infinity`,
 * and an empty string parses to `0` rather than to `NaN`, so `?findings=`
 * rendered a counter the caller never asked for.
 */
export function parseFindingsCount(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;

  return String(Math.min(MAX_FINDINGS_COUNT, Math.floor(parsed)));
}

/** Parse the rank badge, or `undefined` when it should not be drawn. */
export function parseRank(raw: string | null | undefined): CardRank | undefined {
  const candidate = raw?.trim().toUpperCase();
  return (VALID_RANKS as readonly string[]).includes(candidate ?? "")
    ? (candidate as CardRank)
    : undefined;
}

/** `glitch` and its `matrix` alias select the green palette; everything else is the default. */
export function parseTheme(raw: string | null | undefined): CardTheme {
  const candidate = raw?.trim().toLowerCase();
  return candidate === "glitch" || candidate === "matrix" ? "glitch" : "heist";
}

/** The timestamp rendered when the caller did not supply one. */
export function defaultTimestamp(now: Date = new Date()): string {
  return now.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Resolve every drawable value from the query string.
 *
 * Total: any `URLSearchParams` produces a complete, renderable set.
 */
export function parseHeistCardParams(
  searchParams: URLSearchParams,
  now: Date = new Date(),
): HeistCardParams {
  const suppliedTimestamp = sanitizeText(searchParams.get("timestamp"), MAX_TIMESTAMP_LENGTH);
  const stolen = sanitizeText(
    searchParams.get("stolen") ?? searchParams.get("amount"),
    MAX_STOLEN_LENGTH,
  );

  return {
    project: sanitizeText(searchParams.get("project"), MAX_PROJECT_LENGTH) || DEFAULT_PROJECT,
    alias: sanitizeText(searchParams.get("alias"), MAX_ALIAS_LENGTH) || DEFAULT_ALIAS,
    score: parseScore(searchParams.get("score")),
    rank: parseRank(searchParams.get("rank")),
    findingsCount: parseFindingsCount(
      searchParams.get("findingsCount") ?? searchParams.get("findings"),
    ),
    stolen: stolen || undefined,
    theme: parseTheme(searchParams.get("theme")),
    timestamp: suppliedTimestamp || defaultTimestamp(now),
    timestampPinned: suppliedTimestamp.length > 0,
  };
}

/** How long a card whose bytes are fully determined by its URL may be cached. */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * How long a card carrying a render-time timestamp may be cached.
 *
 * Long enough that a link doing the rounds is served from the edge rather than
 * re-rendered per view, short enough that the "Operation Timestamp" on it is not
 * a year stale.
 */
export const TIMESTAMPED_CACHE_CONTROL =
  "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

/**
 * The `Cache-Control` a rendered card should carry.
 *
 * The route stamped `immutable` on every success. That is a promise the bytes
 * behind this URL will never change, and it is false whenever the caller did
 * not supply `timestamp`: the card embeds `new Date()` at render time, so the
 * first view freezes its own clock into every subsequent view for a year.
 *
 * `immutable` is correct exactly when the URL pins every input, which is what
 * `timestampPinned` records.
 */
export function cacheControlFor(params: Pick<HeistCardParams, "timestampPinned">): string {
  return params.timestampPinned ? IMMUTABLE_CACHE_CONTROL : TIMESTAMPED_CACHE_CONTROL;
}
