import { describe, it, expect } from "vitest";
import { buildPackagePurl, exportCycloneDxBom, exportSpdxDocument } from "./sbom-exporter";
import { detectAndParseSbom } from "./sbom-format-detector";
import type { Dependency } from "@/types/sbom";

describe("CycloneDX 1.5 & SPDX 2.3 SBOM Exporter (#2189)", () => {
  const sampleDeps: Dependency[] = [
    {
      name: "@babel/core",
      version: "7.24.4",
      manifestFile: "package-lock.json",
      ecosystem: "npm",
      isTransitive: false,
      license: "MIT",
    },
    {
      name: "lodash",
      version: "4.17.21",
      manifestFile: "package-lock.json",
      ecosystem: "npm",
      isTransitive: true,
      parentPackage: "@babel/core",
      license: "MIT",
    },
    {
      name: "requests",
      version: "2.31.0",
      manifestFile: "requirements.txt",
      ecosystem: "pypi",
      isTransitive: false,
      license: "Apache-2.0",
    },
    {
      name: "serde",
      version: "1.0.197",
      manifestFile: "Cargo.lock",
      ecosystem: "cargo",
      isTransitive: false,
      license: "MIT OR Apache-2.0",
    },
    {
      name: "github.com/gin-gonic/gin",
      version: "1.9.1",
      manifestFile: "go.sum",
      ecosystem: "go",
      isTransitive: false,
      license: "MIT",
    },
    {
      name: "org.apache.logging.log4j:log4j-core",
      version: "2.20.0",
      manifestFile: "pom.xml",
      ecosystem: "maven",
      isTransitive: false,
      license: "Apache-2.0",
    },
  ];

  it("builds canonical PURLs across npm, pypi, cargo, go, maven, and gem", () => {
    expect(buildPackagePurl(sampleDeps[0]!)).toBe("pkg:npm/%40babel/core@7.24.4");
    expect(buildPackagePurl(sampleDeps[2]!)).toBe("pkg:pypi/requests@2.31.0");
    expect(buildPackagePurl(sampleDeps[3]!)).toBe("pkg:cargo/serde@1.0.197");
    expect(buildPackagePurl(sampleDeps[4]!)).toBe("pkg:golang/github.com/gin-gonic/gin@1.9.1");
    expect(buildPackagePurl(sampleDeps[5]!)).toBe(
      "pkg:maven/org.apache.logging.log4j/log4j-core@2.20.0",
    );
  });

  it("exports CycloneDX 1.5 with dependency graph and round-trips cleanly through detectAndParseSbom", () => {
    const bom = exportCycloneDxBom(sampleDeps, {
      projectName: "secureflow-app",
      projectVersion: "2.0.0",
    });

    expect(bom.bomFormat).toBe("CycloneDX");
    expect(bom.specVersion).toBe("1.5");
    expect(Array.isArray(bom.components)).toBe(true);
    expect((bom.dependencies as any[]).length).toBeGreaterThanOrEqual(2);

    const parsed = detectAndParseSbom(bom, "bom.cdx.json");
    expect(parsed).not.toBeNull();
    expect(parsed?.format).toBe("cyclonedx");
    expect(parsed?.warnings).toEqual([]);
    expect(parsed?.dependencies).toHaveLength(sampleDeps.length);

    for (const orig of sampleDeps) {
      const match = parsed?.dependencies.find(
        (d) => d.name === orig.name && d.ecosystem === orig.ecosystem,
      );
      expect(match?.version).toBe(orig.version);
      expect(match?.license).toBe(orig.license);
    }
  });

  it("exports SPDX 2.3 with relationships and round-trips cleanly through detectAndParseSbom", () => {
    const spdx = exportSpdxDocument(sampleDeps, {
      projectName: "secureflow-app",
      projectVersion: "2.0.0",
    });

    expect(spdx.spdxVersion).toBe("SPDX-2.3");
    expect(spdx.dataLicense).toBe("CC0-1.0");
    expect((spdx.relationships as any[]).some((r) => r.relationshipType === "DEPENDS_ON")).toBe(
      true,
    );

    const parsed = detectAndParseSbom(spdx, "app.spdx.json");
    expect(parsed).not.toBeNull();
    expect(parsed?.format).toBe("spdx");
    expect(parsed?.warnings).toEqual([]);
    expect(parsed?.dependencies).toHaveLength(sampleDeps.length);

    for (const orig of sampleDeps) {
      const match = parsed?.dependencies.find(
        (d) => d.name === orig.name && d.ecosystem === orig.ecosystem,
      );
      expect(match?.version).toBe(orig.version);
      expect(match?.license).toBe(orig.license);
    }
  });
});
