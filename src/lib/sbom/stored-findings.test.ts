import { describe, expect, it } from "vitest";
import {
  DEPENDENCY_FINDING_WHERE,
  DEPENDENCY_SNIPPET_PREFIX,
  recoveredMatch,
} from "./stored-findings";

describe("recoveredMatch", () => {
  it("reads name, version and patched version from the stored snippet", () => {
    expect(
      recoveredMatch(
        {
          codeSnippet: "Dependency: lodash@4.17.20\nPatched: 4.17.21",
          explanation: "Prototype pollution (CVE-2021-23337)",
          severity: "HIGH",
        },
        "package.json",
      ),
    ).toEqual({
      dependency: {
        name: "lodash",
        version: "4.17.20",
        manifestFile: "package.json",
        ecosystem: "npm",
      },
      cveId: "CVE-2021-23337",
      severity: "HIGH",
      description: "Prototype pollution (CVE-2021-23337)",
      patchedVersion: "4.17.21",
    });
  });

  it("keeps a scoped npm package whole by splitting at the last @", () => {
    const match = recoveredMatch(
      { codeSnippet: "Dependency: @babel/traverse@7.22.0\nPatched: 7.23.2", severity: "CRITICAL" },
      "package.json",
    );
    expect(match.dependency.name).toBe("@babel/traverse");
    expect(match.dependency.version).toBe("7.22.0");
  });

  it("maps an unknown patched version to null", () => {
    const match = recoveredMatch(
      { codeSnippet: "Dependency: requests@2.0.0\nPatched: Unknown", severity: "LOW" },
      "requirements.txt",
    );
    expect(match.patchedVersion).toBeNull();
    expect(match.dependency.ecosystem).toBe("pypi");
  });

  it("falls back to unknown values for a snippet it cannot parse", () => {
    const match = recoveredMatch({ codeSnippet: null, explanation: null, severity: "MEDIUM" }, "");
    expect(match.dependency).toMatchObject({ name: "unknown", version: "unknown" });
    expect(match.cveId).toBe("CVE-UNKNOWN");
  });
});

describe("DEPENDENCY_FINDING_WHERE", () => {
  it("selects vulnerability findings with the worker's snippet prefix", () => {
    expect(DEPENDENCY_FINDING_WHERE).toEqual({
      type: "VULNERABILITY",
      codeSnippet: { startsWith: DEPENDENCY_SNIPPET_PREFIX },
    });
  });
});
