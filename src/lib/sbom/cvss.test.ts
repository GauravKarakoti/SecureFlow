import { describe, it, expect } from "vitest";
import { cvss3BaseScore, cvssSeverity, roundUp, severityFromCvssEntries } from "./cvss";

describe("cvss3BaseScore", () => {
  // Reference scores from the NVD / FIRST calculator for well-known vectors.
  it.each([
    // Log4Shell (CVE-2021-44228): scope change caps at 10.0
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10.0],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H", 8.8],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H", 7.5],
    // Typical reflected XSS
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", 6.1],
    ["CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N", 5.9],
    ["CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N", 3.3],
    ["CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:C/C:H/I:H/A:H", 9.1],
    ["CVSS:3.0/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H", 8.8],
  ])("%s scores %d", (vector, expected) => {
    expect(cvss3BaseScore(vector)).toBe(expected);
  });

  it("scores a vector with no impact as 0", () => {
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N")).toBe(0);
  });

  it("accepts metrics in any order and ignores temporal metrics", () => {
    expect(cvss3BaseScore("CVSS:3.1/S:U/C:H/I:H/A:H/AV:N/AC:L/PR:N/UI:N/E:P/RL:O")).toBe(9.8);
  });

  it.each([
    ["not a vector at all", "high"],
    ["a CVSS v2 vector", "AV:N/AC:L/Au:N/C:P/I:P/A:P"],
    ["a CVSS v4 vector", "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"],
    ["a vector missing a base metric", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H"],
    ["an unknown metric value", "CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"],
    ["an unknown scope", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:Z/C:H/I:H/A:H"],
    ["a duplicated metric", "CVSS:3.1/AV:N/AV:L/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"],
  ])("returns null for %s", (_label, vector) => {
    expect(cvss3BaseScore(vector)).toBeNull();
  });
});

describe("roundUp", () => {
  it("rounds up to one decimal place", () => {
    expect(roundUp(4.02)).toBe(4.1);
    expect(roundUp(4.0)).toBe(4.0);
  });

  it("does not let floating-point noise push a whole tenth up", () => {
    expect(roundUp(4.000000001)).toBe(4.0);
  });
});

describe("cvssSeverity", () => {
  it.each([
    [10, "CRITICAL"],
    [9.0, "CRITICAL"],
    [8.9, "HIGH"],
    [7.0, "HIGH"],
    [6.9, "MEDIUM"],
    [4.0, "MEDIUM"],
    [3.9, "LOW"],
    [0, "LOW"],
  ] as const)("rates %d as %s", (score, severity) => {
    expect(cvssSeverity(score)).toBe(severity);
  });
});

describe("severityFromCvssEntries", () => {
  it("rates the highest-scoring v3 vector and ignores other types", () => {
    expect(
      severityFromCvssEntries([
        { type: "CVSS_V2", score: "AV:N/AC:L/Au:N/C:C/I:C/A:C" },
        { type: "CVSS_V3", score: "CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N" },
        { type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" },
      ]),
    ).toBe("CRITICAL");
  });

  it("returns null when nothing can be scored", () => {
    expect(severityFromCvssEntries(undefined)).toBeNull();
    expect(severityFromCvssEntries([])).toBeNull();
    expect(
      severityFromCvssEntries([
        {
          type: "CVSS_V4",
          score: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
        },
        { type: "CVSS_V3", score: "garbage" },
      ]),
    ).toBeNull();
  });
});
