import { describe, it, expect } from "vitest";
import {
  extractDirectoryPrefix,
  computeDirectoryTrend,
  groupFindingsByDirectory,
  type RawFindingForHotspot,
} from "./hotspots";

describe("hotspots directory helpers", () => {
  describe("extractDirectoryPrefix", () => {
    it("handles null, empty and undefined gracefully as (root)", () => {
      expect(extractDirectoryPrefix(null)).toEqual({
        displayPath: "(root)",
        filterPrefix: "(root)",
      });
      expect(extractDirectoryPrefix("")).toEqual({
        displayPath: "(root)",
        filterPrefix: "(root)",
      });
      expect(extractDirectoryPrefix(undefined)).toEqual({
        displayPath: "(root)",
        filterPrefix: "(root)",
      });
    });

    it("identifies root files", () => {
      expect(extractDirectoryPrefix("package.json", 1)).toEqual({
        displayPath: "(root)",
        filterPrefix: "(root)",
      });
      expect(extractDirectoryPrefix("README.md", 2)).toEqual({
        displayPath: "(root)",
        filterPrefix: "(root)",
      });
    });

    it("handles depth 1 correctly", () => {
      expect(extractDirectoryPrefix("src/lib/auth.ts", 1)).toEqual({
        displayPath: "src",
        filterPrefix: "src/",
      });
      expect(extractDirectoryPrefix("docs/guides/setup.md", 1)).toEqual({
        displayPath: "docs",
        filterPrefix: "docs/",
      });
    });

    it("handles depth 2 correctly", () => {
      expect(extractDirectoryPrefix("src/lib/auth.ts", 2)).toEqual({
        displayPath: "src/lib",
        filterPrefix: "src/lib/",
      });
      expect(extractDirectoryPrefix("src/index.ts", 2)).toEqual({
        displayPath: "src",
        filterPrefix: "src/",
      });
    });

    it("handles depth 3 correctly", () => {
      expect(extractDirectoryPrefix("src/lib/auth/token.ts", 3)).toEqual({
        displayPath: "src/lib/auth",
        filterPrefix: "src/lib/auth/",
      });
    });

    it("normalizes Windows backslashes and leading slashes", () => {
      expect(extractDirectoryPrefix("\\src\\components\\Button.tsx", 1)).toEqual({
        displayPath: "src",
        filterPrefix: "src/",
      });
      expect(extractDirectoryPrefix("/src/components/Button.tsx", 2)).toEqual({
        displayPath: "src/components",
        filterPrefix: "src/components/",
      });
    });
  });

  describe("computeDirectoryTrend", () => {
    const now = new Date("2026-05-30T12:00:00Z");

    it("returns flat trend when no findings exist", () => {
      const trend = computeDirectoryTrend([], now);
      expect(trend.direction).toBe("flat");
      expect(trend.change).toBe(0);
      expect(trend.percentage).toBe(0);
    });

    it("returns up trend when recent findings outnumber prior findings", () => {
      const recentDate = new Date("2026-05-25T12:00:00Z"); // 5 days ago
      const priorDate = new Date("2026-05-10T12:00:00Z"); // 20 days ago

      const trend = computeDirectoryTrend([recentDate, recentDate, priorDate], now);
      expect(trend.direction).toBe("up");
      expect(trend.change).toBe(1); // 2 - 1 = +1
      expect(trend.percentage).toBe(100);
    });

    it("returns down trend when prior findings outnumber recent findings", () => {
      const recentDate = new Date("2026-05-25T12:00:00Z"); // 5 days ago
      const priorDate = new Date("2026-05-10T12:00:00Z"); // 20 days ago

      const trend = computeDirectoryTrend([recentDate, priorDate, priorDate, priorDate], now);
      expect(trend.direction).toBe("down");
      expect(trend.change).toBe(-2); // 1 - 3 = -2
      expect(trend.percentage).toBe(67); // 2/3 = 66.6% -> 67%
    });
  });

  describe("groupFindingsByDirectory", () => {
    const now = new Date("2026-05-30T12:00:00Z");
    const rawFindings: RawFindingForHotspot[] = [
      {
        fileLocation: "src/lib/auth.ts",
        severity: "CRITICAL",
        createdAt: new Date("2026-05-28T12:00:00Z"),
      },
      {
        fileLocation: "src/lib/db.ts",
        severity: "HIGH",
        createdAt: new Date("2026-05-27T12:00:00Z"),
      },
      {
        fileLocation: "src/components/button.tsx",
        severity: "LOW",
        createdAt: new Date("2026-05-26T12:00:00Z"),
      },
      {
        fileLocation: "docs/readme.md",
        severity: "INFO",
        createdAt: new Date("2026-05-20T12:00:00Z"),
      },
      {
        fileLocation: "package.json",
        severity: "MEDIUM",
        createdAt: new Date("2026-05-18T12:00:00Z"),
      },
    ];

    it("groups findings at depth 1 with severity breakdown and sorting", () => {
      const hotspots = groupFindingsByDirectory(rawFindings, 1, now);
      expect(hotspots.length).toBe(3); // src, docs, (root)

      // src has 3 findings
      expect(hotspots[0].directory).toBe("src");
      expect(hotspots[0].pathPrefix).toBe("src/");
      expect(hotspots[0].openCount).toBe(3);
      expect(hotspots[0].severityCounts).toEqual({
        CRITICAL: 1,
        HIGH: 1,
        MEDIUM: 0,
        LOW: 1,
        INFO: 0,
      });

      // root has 1 finding
      const rootHotspot = hotspots.find((h) => h.directory === "(root)");
      expect(rootHotspot).toBeDefined();
      expect(rootHotspot?.openCount).toBe(1);
      expect(rootHotspot?.severityCounts.MEDIUM).toBe(1);
    });

    it("groups findings at depth 2 properly separating subdirectories", () => {
      const hotspots = groupFindingsByDirectory(rawFindings, 2, now);
      expect(hotspots.map((h) => h.directory)).toContain("src/lib");
      expect(hotspots.map((h) => h.directory)).toContain("src/components");

      const libHotspot = hotspots.find((h) => h.directory === "src/lib");
      expect(libHotspot?.openCount).toBe(2);
      expect(libHotspot?.pathPrefix).toBe("src/lib/");
    });
  });
});
