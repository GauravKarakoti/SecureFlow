/**
 * Dependency-free version comparison for advisory range matching.
 *
 * OSV describes affected versions as `introduced` / `fixed` / `last_affected`
 * events, so deciding which fix applies to an installed version needs an
 * ordering. The scanner covers npm, PyPI, Maven and RubyGems, each with its own
 * scheme (SemVer, PEP 440, Maven qualifiers, Gem::Version). This module does not
 * reimplement any of them exactly. It implements the ordering they all agree on
 * for the versions that appear in advisories:
 *
 *   - dotted numeric components compare numerically (`1.10.0 > 1.9.0`)
 *   - a missing component is zero (`1.0 == 1.0.0`)
 *   - a pre-release tag sorts before its release (`1.0.0-rc.1 < 1.0.0`)
 *   - a post-release tag sorts after its release (`1.0.post1 > 1.0`)
 *
 * It is used to pick *between* fixed versions, never to decide whether a package
 * is vulnerable — OSV already made that call server-side.
 */

type Token = { numeric: true; value: string } | { numeric: false; value: string };

const TOKEN_PATTERN = /\d+|[a-z]+/gi;

/** Qualifiers that name the release itself; they carry no ordering information. */
const RELEASE_ALIASES = new Set(["final", "ga", "release"]);

/** Qualifiers that sort *after* the bare release. */
const POST_RELEASE_TAGS = new Set(["post", "rev", "r", "sp", "patch", "p"]);

/** Pre-release qualifiers, lowest first. Anything unlisted is ranked with `rc`. */
const PRE_RELEASE_RANKS: Record<string, number> = {
  dev: -5,
  snapshot: -5,
  alpha: -4,
  a: -4,
  beta: -3,
  b: -3,
  rc: -2,
  cr: -2,
  c: -2,
  pre: -2,
  preview: -2,
};

const UNKNOWN_TAG_RANK = -2;

/** The implicit component used to pad the shorter of two versions. */
const ZERO: Token = { numeric: true, value: "0" };

function tagRank(tag: string): number {
  if (POST_RELEASE_TAGS.has(tag)) return 1;
  return PRE_RELEASE_RANKS[tag] ?? UNKNOWN_TAG_RANK;
}

/**
 * Split a version into comparable tokens.
 *
 * A leading range operator or `v` is dropped (`^4.17.21`, `>=1.0.0`, `v2.0.0`
 * all name a version), as is SemVer build metadata (`1.0.0+build.5`), which
 * SemVer defines as irrelevant to precedence.
 */
function tokenize(version: string): Token[] {
  const core = version
    .trim()
    .replace(/^[\s=^~<>]*v?(?=\d)/i, "")
    .split("+")[0];

  const tokens: Token[] = [];
  for (const raw of core.match(TOKEN_PATTERN) ?? []) {
    if (/^\d/.test(raw)) {
      // Leading zeros are dropped so `01` and `1` are one component. Kept as a
      // string so a very long component (a date stamp, say) never loses
      // precision the way `Number()` would.
      tokens.push({ numeric: true, value: raw.replace(/^0+(?=\d)/, "") });
      continue;
    }

    const tag = raw.toLowerCase();
    if (!RELEASE_ALIASES.has(tag)) tokens.push({ numeric: false, value: tag });
  }

  return tokens;
}

function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Order a qualifier against a number occupying the same position. */
function compareTagToNumber(tag: string, num: string): number {
  // `1.0.0-rc.1` against `1.0.0`: the pre-release is lower than anything a plain
  // number in that position can express, including the implicit zero.
  if (tagRank(tag) < 0) return -1;

  // `1.0.post1` sits above the bare `1.0` (a zero in that position) but below
  // `1.0.1`, the next real release.
  return num === "0" ? 1 : -1;
}

function compareTokens(x: Token, y: Token): number {
  if (x.numeric && y.numeric) return compareNumeric(x.value, y.value);

  if (!x.numeric && !y.numeric) {
    const byRank = tagRank(x.value) - tagRank(y.value);
    if (byRank !== 0) return byRank < 0 ? -1 : 1;
    if (x.value === y.value) return 0;
    return x.value < y.value ? -1 : 1;
  }

  return x.numeric ? -compareTagToNumber(y.value, x.value) : compareTagToNumber(x.value, y.value);
}

/**
 * Compare two version strings.
 *
 * Returns a negative number when `a` is older than `b`, a positive number when
 * it is newer, and `0` when they are equivalent.
 */
export function compareVersions(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i++) {
    const result = compareTokens(left[i] ?? ZERO, right[i] ?? ZERO);
    if (result !== 0) return result;
  }

  return 0;
}
