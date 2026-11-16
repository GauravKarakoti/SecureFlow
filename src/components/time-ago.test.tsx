/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import React from "react";
import { render, screen, act } from "@testing-library/react";
import {
  TimeAgo,
  formatRelativeTime,
  formatTimestamp,
  formatLocalTime,
  formatUtcTime,
} from "./time-ago";

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe("formatRelativeTime and formatTimestamp", () => {
  const BASE_NOW = new Date("2026-11-15T12:00:00.000Z").getTime();

  it("handles invalid dates", () => {
    expect(formatRelativeTime("invalid-date", BASE_NOW)).toBe("Invalid date");
    expect(formatTimestamp(new Date(NaN), BASE_NOW)).toBe("Invalid date");
  });

  describe("seconds thresholds", () => {
    it("formats diff < 5 seconds as 'just now'", () => {
      expect(formatRelativeTime(new Date(BASE_NOW - 0), BASE_NOW)).toBe("just now");
      expect(formatRelativeTime(new Date(BASE_NOW - 2000), BASE_NOW)).toBe("just now");
      expect(formatRelativeTime(new Date(BASE_NOW - 4999), BASE_NOW)).toBe("just now");
    });

    it("formats 5 to 59 seconds as '{s} seconds ago'", () => {
      expect(formatRelativeTime(new Date(BASE_NOW - 5000), BASE_NOW)).toBe("5 seconds ago");
      expect(formatRelativeTime(new Date(BASE_NOW - 30000), BASE_NOW)).toBe("30 seconds ago");
      expect(formatTimestamp(new Date(BASE_NOW - 59000), BASE_NOW)).toBe("59 seconds ago");
    });
  });

  describe("minutes thresholds", () => {
    it("formats 60s to 119s as '1 minute ago'", () => {
      expect(formatRelativeTime(new Date(BASE_NOW - 60000), BASE_NOW)).toBe("1 minute ago");
      expect(formatRelativeTime(new Date(BASE_NOW - 119000), BASE_NOW)).toBe("1 minute ago");
    });

    it("formats 2m to 59m as '{m} minutes ago'", () => {
      expect(formatRelativeTime(new Date(BASE_NOW - 2 * 60000), BASE_NOW)).toBe("2 minutes ago");
      expect(formatTimestamp(new Date(BASE_NOW - 5 * 60000), BASE_NOW)).toBe("5 minutes ago");
      expect(formatRelativeTime(new Date(BASE_NOW - 59 * 60000), BASE_NOW)).toBe("59 minutes ago");
    });
  });

  describe("hours thresholds", () => {
    it("formats 1h to < 2h as '1 hour ago'", () => {
      expect(formatRelativeTime(new Date(BASE_NOW - 3600000), BASE_NOW)).toBe("1 hour ago");
      expect(formatRelativeTime(new Date(BASE_NOW - 7100000), BASE_NOW)).toBe("1 hour ago");
    });

    it("formats 2h to < 24h as '{h} hours ago'", () => {
      expect(formatRelativeTime(new Date(BASE_NOW - 2 * 3600000), BASE_NOW)).toBe("2 hours ago");
      expect(formatTimestamp(new Date(BASE_NOW - 8 * 3600000), BASE_NOW)).toBe("8 hours ago");
      expect(formatRelativeTime(new Date(BASE_NOW - 23 * 3600000), BASE_NOW)).toBe("23 hours ago");
    });
  });

  describe("days thresholds", () => {
    it("formats 1d to < 2d as '1 day ago'", () => {
      expect(formatRelativeTime(new Date(BASE_NOW - 86400000), BASE_NOW)).toBe("1 day ago");
      expect(formatRelativeTime(new Date(BASE_NOW - 1.5 * 86400000), BASE_NOW)).toBe("1 day ago");
    });

    it("formats 2d to < 30d as '{d} days ago'", () => {
      expect(formatRelativeTime(new Date(BASE_NOW - 2 * 86400000), BASE_NOW)).toBe("2 days ago");
      expect(formatTimestamp(new Date(BASE_NOW - 14 * 86400000), BASE_NOW)).toBe("14 days ago");
      expect(formatRelativeTime(new Date(BASE_NOW - 29 * 86400000), BASE_NOW)).toBe("29 days ago");
    });
  });

  describe("months and years thresholds", () => {
    it("formats 30d to < 60d as '1 month ago'", () => {
      expect(formatRelativeTime(new Date(BASE_NOW - 30 * 86400000), BASE_NOW)).toBe("1 month ago");
    });

    it("formats months as '{m} months ago'", () => {
      expect(formatRelativeTime(new Date(BASE_NOW - 90 * 86400000), BASE_NOW)).toBe("3 months ago");
    });

    it("formats 1 year as '1 year ago'", () => {
      expect(formatRelativeTime(new Date(BASE_NOW - 365 * 86400000), BASE_NOW)).toBe("1 year ago");
    });

    it("formats multiple years as '{y} years ago'", () => {
      expect(formatRelativeTime(new Date(BASE_NOW - 750 * 86400000), BASE_NOW)).toBe("2 years ago");
    });
  });

  describe("future dates", () => {
    it("formats near-immediate future as 'just now'", () => {
      expect(formatRelativeTime(new Date(BASE_NOW + 3000), BASE_NOW)).toBe("just now");
    });

    it("formats future timestamps gracefully", () => {
      expect(formatRelativeTime(new Date(BASE_NOW + 20000), BASE_NOW)).toBe("in 20 seconds");
      expect(formatRelativeTime(new Date(BASE_NOW + 120000), BASE_NOW)).toBe("in 2 minutes");
      expect(formatRelativeTime(new Date(BASE_NOW + 7200000), BASE_NOW)).toBe("in 2 hours");
    });
  });
});

describe("formatUtcTime and formatLocalTime", () => {
  const date = new Date("2026-11-15T12:30:45.000Z");

  it("formats UTC time explicitly with UTC suffix", () => {
    const utc = formatUtcTime(date);
    expect(utc).toContain("2026");
    expect(utc).toContain("UTC");
    expect(formatUtcTime("invalid")).toBe("Invalid date");
  });

  it("formats local time using Intl formatting", () => {
    const local = formatLocalTime(date, "en-US");
    expect(local).toContain("2026");
    expect(formatLocalTime("invalid")).toBe("Invalid date");
  });
});

describe("<TimeAgo /> Component", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders relative time with proper time element attributes", () => {
    const now = new Date("2026-11-15T12:00:00.000Z");
    vi.setSystemTime(now);

    const pastDate = new Date("2026-11-15T11:55:00.000Z"); // 5 minutes ago

    render(<TimeAgo date={pastDate} />);

    const timeEl = screen.getByText("5 minutes ago");
    expect(timeEl.tagName.toLowerCase()).toBe("time");
    expect(timeEl).toHaveAttribute("datetime", pastDate.toISOString());
  });

  it("updates relative time dynamically without page reload", () => {
    const now = new Date("2026-11-15T12:00:00.000Z");
    vi.setSystemTime(now);

    const date = new Date(now.getTime() - 25000); // 25 seconds ago

    render(<TimeAgo date={date} updateIntervalMs={5000} />);
    expect(screen.getByText("25 seconds ago")).toBeInTheDocument();

    // Advance timer by 10 seconds
    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(screen.getByText("35 seconds ago")).toBeInTheDocument();
  });

  it("renders tooltip title containing local and UTC times after mounting", () => {
    const now = new Date("2026-11-15T12:00:00.000Z");
    vi.setSystemTime(now);

    render(<TimeAgo date={now} />);

    const timeEl = screen.getByText("just now");
    expect(timeEl).toHaveAttribute("title");
    const title = timeEl.getAttribute("title") || "";
    expect(title).toContain("Local:");
    expect(title).toContain("UTC:");
  });

  it("handles invalid dates gracefully without throwing", () => {
    render(<TimeAgo date="not-a-valid-date" />);
    expect(screen.getByText("Invalid date")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    const now = new Date("2026-11-15T12:00:00.000Z");
    vi.setSystemTime(now);

    render(<TimeAgo date={now} className="custom-test-class" />);
    const timeEl = screen.getByText("just now");
    expect(timeEl).toHaveClass("custom-test-class");
  });
});
