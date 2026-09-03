import { describe, it, expect } from "vitest";
import {
  generateDateRange,
  formatDateLabel,
  buildDateIndex,
  computeTrendDirection,
  computePassRate,
  roundTo,
} from "./scan-history";

describe("generateDateRange", () => {
  it("returns the correct number of date strings", () => {
    const range = generateDateRange(7);
    expect(range).toHaveLength(7);
  });

  it("returns ISO-formatted dates", () => {
    const range = generateDateRange(3);
    for (const date of range) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("returns dates in chronological order (oldest first)", () => {
    const range = generateDateRange(5);
    for (let i = 1; i < range.length; i++) {
      expect(range[i] > range[i - 1]).toBe(true);
    }
  });

  it("ends with today's date", () => {
    const range = generateDateRange(1);
    const today = new Date().toISOString().split("T")[0];
    expect(range[0]).toBe(today);
  });

  it("handles zero days", () => {
    const range = generateDateRange(0);
    expect(range).toHaveLength(0);
  });
});

describe("formatDateLabel", () => {
  it("formats a date string to 'Mon DD'", () => {
    expect(formatDateLabel("2026-08-15")).toBe("Aug 15");
  });

  it("formats January 1st", () => {
    expect(formatDateLabel("2026-01-01")).toBe("Jan 1");
  });

  it("formats December 31st", () => {
    expect(formatDateLabel("2026-12-31")).toBe("Dec 31");
  });
});

describe("buildDateIndex", () => {
  it("maps each date to its array index", () => {
    const dates = ["2026-08-01", "2026-08-02", "2026-08-03"];
    const idx = buildDateIndex(dates);
    expect(idx.get("2026-08-01")).toBe(0);
    expect(idx.get("2026-08-02")).toBe(1);
    expect(idx.get("2026-08-03")).toBe(2);
  });

  it("returns undefined for dates not in the range", () => {
    const dates = ["2026-08-01"];
    const idx = buildDateIndex(dates);
    expect(idx.get("2026-08-02")).toBeUndefined();
  });

  it("handles empty arrays", () => {
    const idx = buildDateIndex([]);
    expect(idx.size).toBe(0);
  });
});

describe("computeTrendDirection", () => {
  it("returns 'flat' for a single-element array", () => {
    expect(computeTrendDirection([5])).toBe("flat");
  });

  it("returns 'flat' for identical halves", () => {
    expect(computeTrendDirection([10, 10, 10, 10])).toBe("flat");
  });

  it("returns 'up' when second half is significantly higher", () => {
    expect(computeTrendDirection([1, 1, 5, 5])).toBe("up");
  });

  it("returns 'down' when second half is significantly lower", () => {
    expect(computeTrendDirection([5, 5, 1, 1])).toBe("down");
  });

  it("returns 'flat' when change is below threshold", () => {
    // 95 vs 100 is a 5% decrease, which is safely below the threshold
    expect(computeTrendDirection([100, 100, 95, 95])).toBe("flat");
  });

  it("handles all zeros", () => {
    expect(computeTrendDirection([0, 0, 0, 0])).toBe("flat");
  });

  it("returns 'up' when going from zero to nonzero", () => {
    expect(computeTrendDirection([0, 0, 5, 5])).toBe("up");
  });

  it("returns 'down' when going to zero", () => {
    expect(computeTrendDirection([5, 5, 0, 0])).toBe("down");
  });

  it("returns 'flat' for empty array", () => {
    expect(computeTrendDirection([])).toBe("flat");
  });
});

describe("computePassRate", () => {
  it("returns 100 for all passed", () => {
    expect(computePassRate(10, 10)).toBe(100);
  });

  it("returns 0 for none passed", () => {
    expect(computePassRate(0, 10)).toBe(0);
  });

  it("returns 0 when total is 0", () => {
    expect(computePassRate(0, 0)).toBe(0);
  });

  it("computes a rounded percentage", () => {
    expect(computePassRate(1, 3)).toBe(33);
  });

  it("rounds 0.5 up", () => {
    expect(computePassRate(1, 2)).toBe(50);
  });
});

describe("roundTo", () => {
  it("rounds to one decimal place", () => {
    expect(roundTo(3.456)).toBe(3.5);
  });

  it("rounds to two decimal places", () => {
    expect(roundTo(3.456, 2)).toBe(3.46);
  });

  it("rounds zero", () => {
    expect(roundTo(0)).toBe(0);
  });

  it("rounds integers", () => {
    expect(roundTo(42)).toBe(42);
  });

  it("handles negative numbers", () => {
    expect(roundTo(-3.456)).toBe(-3.5);
  });
});
