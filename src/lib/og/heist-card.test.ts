import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALIAS,
  DEFAULT_PROJECT,
  DEFAULT_SCORE,
  IMMUTABLE_CACHE_CONTROL,
  MAX_ALIAS_LENGTH,
  MAX_FINDINGS_COUNT,
  MAX_PROJECT_LENGTH,
  MAX_STOLEN_LENGTH,
  MAX_TIMESTAMP_LENGTH,
  TIMESTAMPED_CACHE_CONTROL,
  cacheControlFor,
  parseFindingsCount,
  parseHeistCardParams,
  parseRank,
  parseScore,
  parseTheme,
  sanitizeText,
} from "./heist-card";

const params = (query: string) => parseHeistCardParams(new URLSearchParams(query));

describe("sanitizeText", () => {
  it("trims and collapses whitespace", () => {
    expect(sanitizeText("  the   vault  ", 60)).toBe("the vault");
  });

  it("caps at the requested length", () => {
    expect(sanitizeText("x".repeat(500), 60)).toHaveLength(60);
  });

  it("replaces control characters rather than rendering them", () => {
    expect(sanitizeText("a\u0000b\u001Fc", 60)).toBe("a b c");
  });

  it("drops newlines, which the single-line layout has no row for", () => {
    expect(sanitizeText("line one\nline two", 60)).toBe("line one line two");
  });

  it("strips zero-width and bidi-override characters", () => {
    expect(sanitizeText("SECURE\u200BFLOW\u202E", 60)).toBe("SECUREFLOW");
  });

  it("caps after stripping, so invisible characters do not consume budget", () => {
    // 200 zero-width characters followed by real text used to fill the cap with
    // nothing and truncate the part a reader can see.
    expect(sanitizeText("\u200B".repeat(200) + "Vault", 10)).toBe("Vault");
  });

  it("returns empty for non-strings", () => {
    expect(sanitizeText(null, 60)).toBe("");
    expect(sanitizeText(undefined, 60)).toBe("");
  });
});

describe("parseScore", () => {
  it("clamps into 0..100", () => {
    expect(parseScore("150")).toBe(100);
    expect(parseScore("-20")).toBe(0);
    expect(parseScore("73")).toBe(73);
  });

  it("rounds to an integer", () => {
    expect(parseScore("73.6")).toBe(74);
  });

  it("falls back rather than rendering NaN in 86px type", () => {
    expect(parseScore("banana")).toBe(DEFAULT_SCORE);
    expect(parseScore("")).toBe(DEFAULT_SCORE);
    expect(parseScore(null)).toBe(DEFAULT_SCORE);
  });

  it("rejects Infinity", () => {
    expect(parseScore("Infinity")).toBe(DEFAULT_SCORE);
    expect(parseScore("-Infinity")).toBe(DEFAULT_SCORE);
  });
});

describe("parseFindingsCount", () => {
  it("renders a plain non-negative integer", () => {
    expect(parseFindingsCount("42")).toBe("42");
    expect(parseFindingsCount("0")).toBe("0");
  });

  it("omits the counter for an empty parameter", () => {
    // `Number('')` is 0 and is not NaN, so `?findings=` used to render
    // "Findings Logged: 0" for a caller who never supplied a count.
    expect(parseFindingsCount("")).toBeUndefined();
    expect(parseFindingsCount("   ")).toBeUndefined();
  });

  it("omits the counter for Infinity", () => {
    expect(parseFindingsCount("Infinity")).toBeUndefined();
  });

  it("does not render exponent notation", () => {
    // `?findings=1e21` used to draw "1e+21".
    expect(parseFindingsCount("1e21")).toBe(String(MAX_FINDINGS_COUNT));
  });

  it("caps at the readable ceiling", () => {
    expect(parseFindingsCount("999999999")).toBe(String(MAX_FINDINGS_COUNT));
  });

  it("floors a fractional count", () => {
    expect(parseFindingsCount("4.9")).toBe("4");
  });

  it("omits a negative count", () => {
    expect(parseFindingsCount("-3")).toBeUndefined();
  });

  it("omits anything unparseable", () => {
    expect(parseFindingsCount("lots")).toBeUndefined();
    expect(parseFindingsCount(null)).toBeUndefined();
  });
});

describe("parseRank", () => {
  it.each(["S", "A", "B", "C", "D"])("accepts %s", (rank) => {
    expect(parseRank(rank)).toBe(rank);
  });

  it("upper-cases and trims", () => {
    expect(parseRank(" s ")).toBe("S");
  });

  it("omits the badge for anything else", () => {
    expect(parseRank("Z")).toBeUndefined();
    expect(parseRank("")).toBeUndefined();
    expect(parseRank(null)).toBeUndefined();
  });
});

describe("parseTheme", () => {
  it("recognises glitch and its matrix alias", () => {
    expect(parseTheme("glitch")).toBe("glitch");
    expect(parseTheme("MATRIX")).toBe("glitch");
  });

  it("defaults to heist", () => {
    expect(parseTheme(null)).toBe("heist");
    expect(parseTheme("something-else")).toBe("heist");
  });
});

describe("parseHeistCardParams", () => {
  it("bounds the timestamp, which had no cap at all", () => {
    // The reported vector: every other field was sliced inline, this one went
    // from searchParams straight into the JSX.
    const parsed = params(`timestamp=${"A".repeat(60_000)}`);

    expect(parsed.timestamp).toHaveLength(MAX_TIMESTAMP_LENGTH);
    expect(parsed.timestampPinned).toBe(true);
  });

  it("bounds every rendered text field", () => {
    const long = "A".repeat(5_000);
    const parsed = params(`project=${long}&alias=${long}&stolen=${long}&timestamp=${long}`);

    expect(parsed.project).toHaveLength(MAX_PROJECT_LENGTH);
    expect(parsed.alias).toHaveLength(MAX_ALIAS_LENGTH);
    expect(parsed.stolen).toHaveLength(MAX_STOLEN_LENGTH);
    expect(parsed.timestamp).toHaveLength(MAX_TIMESTAMP_LENGTH);
  });

  it("applies the defaults when nothing is supplied", () => {
    const parsed = parseHeistCardParams(new URLSearchParams(), new Date("2026-08-27T22:15:00Z"));

    expect(parsed.project).toBe(DEFAULT_PROJECT);
    expect(parsed.alias).toBe(DEFAULT_ALIAS);
    expect(parsed.score).toBe(DEFAULT_SCORE);
    expect(parsed.rank).toBeUndefined();
    expect(parsed.findingsCount).toBeUndefined();
    expect(parsed.stolen).toBeUndefined();
    expect(parsed.theme).toBe("heist");
    expect(parsed.timestamp).not.toBe("");
    expect(parsed.timestampPinned).toBe(false);
  });

  it("falls back to the default when a field sanitises to nothing", () => {
    expect(params("project=%20%20").project).toBe(DEFAULT_PROJECT);
    expect(params("alias=\u200B").alias).toBe(DEFAULT_ALIAS);
  });

  it("accepts the findings and stolen aliases", () => {
    expect(params("findings=7").findingsCount).toBe("7");
    expect(params("findingsCount=9").findingsCount).toBe("9");
    expect(params("amount=%2412M").stolen).toBe("$12M");
  });

  it("prefers the canonical name when both aliases are present", () => {
    expect(params("findingsCount=1&findings=2").findingsCount).toBe("1");
  });

  it("reads a full query end to end", () => {
    const parsed = params(
      "project=SecureFlow&alias=Tokyo&score=88&rank=a&findings=12&stolen=%2412M&theme=glitch&timestamp=Aug%2027",
    );

    expect(parsed).toEqual({
      project: "SecureFlow",
      alias: "Tokyo",
      score: 88,
      rank: "A",
      findingsCount: "12",
      stolen: "$12M",
      theme: "glitch",
      timestamp: "Aug 27",
      timestampPinned: true,
    });
  });

  it("never yields a value long enough to be a layout cost", () => {
    const hostile = "B".repeat(100_000);
    const parsed = params(
      `project=${hostile}&alias=${hostile}&stolen=${hostile}&timestamp=${hostile}&score=${hostile}&findings=${hostile}`,
    );

    const drawn = [parsed.project, parsed.alias, parsed.stolen ?? "", parsed.timestamp];
    for (const value of drawn) {
      expect(value.length).toBeLessThanOrEqual(MAX_PROJECT_LENGTH);
    }
    expect(String(parsed.score).length).toBeLessThanOrEqual(3);
    expect(parsed.findingsCount).toBeUndefined();
  });
});

describe("cacheControlFor", () => {
  it("promises immutability only when the URL pins every input", () => {
    expect(cacheControlFor({ timestampPinned: true })).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it("does not freeze a card that embeds its own render time", () => {
    // The route stamped `immutable, max-age=31536000` on every success, so the
    // first view's clock was served to every later view for a year.
    const header = cacheControlFor({ timestampPinned: false });

    expect(header).toBe(TIMESTAMPED_CACHE_CONTROL);
    expect(header).not.toContain("immutable");
  });

  it("still allows edge caching for the unpinned case", () => {
    // The point is a finite lifetime, not no caching: a link doing the rounds
    // should not re-render per view.
    expect(cacheControlFor({ timestampPinned: false })).toContain("s-maxage=");
  });

  it("is driven by what parseHeistCardParams actually saw", () => {
    expect(cacheControlFor(params("timestamp=Aug%2027"))).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(cacheControlFor(params("project=SecureFlow"))).toBe(TIMESTAMPED_CACHE_CONTROL);
    // A timestamp that sanitises away is not a pinned timestamp.
    expect(cacheControlFor(params("timestamp=%20"))).toBe(TIMESTAMPED_CACHE_CONTROL);
  });
});
