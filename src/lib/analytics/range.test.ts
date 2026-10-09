import { describe, expect, it } from "vitest";
import { ANALYTICS_RANGES, DEFAULT_ANALYTICS_RANGE, parseAnalyticsRange } from "./range";

describe("parseAnalyticsRange", () => {
  it.each(ANALYTICS_RANGES)("accepts %i", (range) => {
    expect(parseAnalyticsRange(String(range))).toBe(range);
  });

  it("defaults to 30 days when absent", () => {
    expect(DEFAULT_ANALYTICS_RANGE).toBe(30);
    expect(parseAnalyticsRange(undefined)).toBe(30);
    expect(parseAnalyticsRange(null)).toBe(30);
    expect(parseAnalyticsRange("")).toBe(30);
  });

  it("falls back to the default for anything it does not offer", () => {
    // An arbitrary window would build that many chart buckets and widen every query.
    for (const raw of ["100000", "0", "-7", "7.5", "abc", "14"]) {
      expect(parseAnalyticsRange(raw)).toBe(30);
    }
  });

  it("reads the first value of a repeated parameter", () => {
    expect(parseAnalyticsRange(["90", "7"])).toBe(90);
  });
});
