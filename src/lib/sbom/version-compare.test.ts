import { describe, it, expect } from "vitest";
import { compareVersions } from "./version-compare";

describe("compareVersions", () => {
  it.each([
    ["1.0.0", "1.0.1", -1],
    ["1.9.0", "1.10.0", -1],
    ["5.7.2", "6.3.1", -1],
    ["7.5.2", "6.3.1", 1],
    ["1.0", "1.0.0", 0],
    ["1.0.0", "1.0.0", 0],
    ["01.2.3", "1.2.3", 0],
    ["20240101123456789", "20240101123456790", -1],
  ])("compares %s with %s", (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
  });

  it("ignores range operators, a leading v and build metadata", () => {
    expect(compareVersions("^4.17.21", "4.17.21")).toBe(0);
    expect(compareVersions(">=1.0.0", "v1.0.0")).toBe(0);
    expect(compareVersions("1.0.0+build.5", "1.0.0+build.9")).toBe(0);
  });

  it("orders pre-releases before the release", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-rc1", "1.0.0-rc.1")).toBe(0);
    expect(compareVersions("2.0.0.dev1", "2.0.0a1")).toBeLessThan(0);
  });

  it("orders post-releases after the release but before the next one", () => {
    expect(compareVersions("1.0.post1", "1.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.post1", "1.0.1")).toBeLessThan(0);
  });

  it("treats final/GA qualifiers as the release itself", () => {
    expect(compareVersions("5.3.0.RELEASE", "5.3.0")).toBe(0);
    expect(compareVersions("1.0.0.Final", "1.0.0")).toBe(0);
  });

  it("is antisymmetric and yields a stable total order", () => {
    const ordered = ["0.9", "1.0.0-alpha", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0", "2.0.0"];
    for (const a of ordered) {
      for (const b of ordered) {
        expect(Math.sign(compareVersions(a, b))).toBe(-Math.sign(compareVersions(b, a)) || 0);
      }
    }
    const shuffled = [...ordered].reverse().sort(compareVersions);
    expect(shuffled).toEqual(ordered);
  });
});
