import { describe, it, expect } from "vitest";
import type { Dependency } from "@/types/sbom";
import { extractFixedVersion, mapOsvVulns, type OsvVulnerability } from "./osv-client";

/** Shape of GHSA-c2qf-rxjj-qqgw: one range, one fix per maintained release line. */
const semverAdvisory: OsvVulnerability = {
  id: "GHSA-c2qf-rxjj-qqgw",
  affected: [
    {
      package: { name: "semver", ecosystem: "npm" },
      ranges: [
        {
          type: "SEMVER",
          events: [
            { introduced: "0" },
            { fixed: "5.7.2" },
            { introduced: "6.0.0" },
            { fixed: "6.3.1" },
            { introduced: "7.0.0" },
            { fixed: "7.5.2" },
          ],
        },
      ],
    },
  ],
};

describe("extractFixedVersion with an installed version", () => {
  it.each([
    ["5.0.0", "5.7.2"],
    ["5.7.1", "5.7.2"],
    ["6.1.0", "6.3.1"],
    ["7.3.0", "7.5.2"],
    ["7.5.2-rc.1", "7.5.2"],
    ["v7.0.0", "7.5.2"],
  ])("picks the fix for the release line of %s", (installed, expected) => {
    expect(extractFixedVersion(semverAdvisory, "semver", installed)).toBe(expected);
  });

  it("never suggests a version below the installed one", () => {
    const vuln: OsvVulnerability = {
      id: "GHSA-3h5v-q93c-6h6q",
      affected: [
        {
          package: { name: "ws", ecosystem: "npm" },
          ranges: [{ type: "SEMVER", events: [{ introduced: "5.0.0" }, { fixed: "5.2.4" }] }],
        },
        {
          package: { name: "ws", ecosystem: "npm" },
          ranges: [{ type: "SEMVER", events: [{ introduced: "8.0.0" }, { fixed: "8.17.1" }] }],
        },
      ],
    };
    expect(extractFixedVersion(vuln, "ws", "8.16.0")).toBe("8.17.1");
    expect(extractFixedVersion(vuln, "ws", "5.1.0")).toBe("5.2.4");
  });

  it("falls back to the nearest upgrade when the line has no fix", () => {
    const vuln: OsvVulnerability = {
      id: "GHSA-x",
      affected: [
        {
          package: { name: "pkg", ecosystem: "npm" },
          ranges: [
            {
              type: "ECOSYSTEM",
              events: [
                { introduced: "0" },
                { last_affected: "1.9.0" },
                { introduced: "2.0.0" },
                { fixed: "2.4.0" },
              ],
            },
          ],
        },
      ],
    };
    expect(extractFixedVersion(vuln, "pkg", "1.5.0")).toBe("2.4.0");
    expect(extractFixedVersion(vuln, "pkg", "2.1.0")).toBe("2.4.0");
  });

  it("returns null rather than a fix that is not an upgrade", () => {
    const vuln: OsvVulnerability = {
      id: "GHSA-y",
      affected: [
        {
          package: { name: "pkg", ecosystem: "npm" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.0" }] }],
        },
      ],
    };
    expect(extractFixedVersion(vuln, "pkg", "2.0.0")).toBeNull();
  });

  it("ignores GIT ranges, whose fixed value is a commit hash", () => {
    const sha = "8f3a2c1d9e7b6a5f4c3b2a1908f7e6d5c4b3a291";
    const gitFirst: OsvVulnerability = {
      id: "OSV-1",
      affected: [
        {
          package: { name: "pkg", ecosystem: "npm" },
          ranges: [
            { type: "GIT", events: [{ introduced: "0" }, { fixed: sha }] },
            { type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.2.3" }] },
          ],
        },
      ],
    };
    const gitOnly: OsvVulnerability = {
      id: "OSV-2",
      affected: [
        {
          package: { name: "pkg", ecosystem: "npm" },
          ranges: [{ type: "GIT", events: [{ introduced: "0" }, { fixed: sha }] }],
        },
      ],
    };
    expect(extractFixedVersion(gitFirst, "pkg", "1.0.0")).toBe("1.2.3");
    expect(extractFixedVersion(gitFirst, "pkg")).toBe("1.2.3");
    expect(extractFixedVersion(gitOnly, "pkg", "1.0.0")).toBeNull();
  });
});

describe("extractFixedVersion without an installed version", () => {
  it("keeps returning the first fixed version in document order", () => {
    expect(extractFixedVersion(semverAdvisory, "semver")).toBe("5.7.2");
    expect(extractFixedVersion(semverAdvisory, "semver", null)).toBe("5.7.2");
    expect(extractFixedVersion(semverAdvisory, "semver", "unknown")).toBe("5.7.2");
  });
});

describe("mapOsvVulns", () => {
  it("reports the fix for the dependency's own release line", () => {
    const dep: Dependency = {
      name: "semver",
      version: "7.3.0",
      manifestFile: "package.json",
      ecosystem: "npm",
    };
    const [match] = mapOsvVulns(dep, [semverAdvisory]);
    expect(match.patchedVersion).toBe("7.5.2");
  });
});
