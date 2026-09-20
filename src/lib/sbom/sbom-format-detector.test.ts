import { describe, it, expect } from "vitest";
import { detectAndParseSbom } from "./sbom-format-detector";

const VALID_CYCLONEDX = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  components: [
    {
      type: "library",
      name: "express",
      version: "4.18.2",
      purl: "pkg:npm/express@4.18.2",
    },
    {
      type: "library",
      name: "lodash",
      version: "4.17.21",
      purl: "pkg:npm/lodash@4.17.21",
    },
  ],
};

const VALID_SPDX = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  packages: [
    {
      SPDXID: "SPDXRef-Package-flask",
      name: "flask",
      versionInfo: "2.3.2",
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: "pkg:pypi/flask@2.3.2",
        },
      ],
    },
    {
      SPDXID: "SPDXRef-Package-requests",
      name: "requests",
      versionInfo: "2.31.0",
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: "pkg:pypi/requests@2.31.0",
        },
      ],
    },
  ],
};

describe("detectAndParseSbom", () => {
  describe("CycloneDX", () => {
    it("parses a valid CycloneDX document", () => {
      const result = detectAndParseSbom(VALID_CYCLONEDX, "bom.json");

      expect(result).not.toBeNull();
      expect(result!.format).toBe("cyclonedx");
      expect(result!.warnings).toEqual([]);
      expect(result!.dependencies).toEqual([
        {
          name: "express",
          version: "4.18.2",
          manifestFile: "bom.json",
          ecosystem: "npm",
        },
        {
          name: "lodash",
          version: "4.17.21",
          manifestFile: "bom.json",
          ecosystem: "npm",
        },
      ]);
    });

    it("defaults version to unknown when missing", () => {
      const doc = {
        bomFormat: "CycloneDX",
        specVersion: "1.4",
        components: [{ type: "library", name: "leftpad", purl: "pkg:npm/leftpad" }],
      };

      const result = detectAndParseSbom(doc, "bom.json");

      expect(result!.format).toBe("cyclonedx");
      expect(result!.dependencies).toHaveLength(1);
      expect(result!.dependencies[0].version).toBe("unknown");
      expect(result!.warnings).toContain(
        'components[0] (leftpad): missing version, defaulting to "unknown"',
      );
    });

    it("skips components with missing name and warns", () => {
      const doc = {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        components: [
          { type: "library", version: "1.0.0" },
          { type: "library", name: "valid-pkg", version: "2.0.0", purl: "pkg:npm/valid-pkg@2.0.0" },
        ],
      };

      const result = detectAndParseSbom(doc, "sbom.json");

      expect(result!.dependencies).toHaveLength(1);
      expect(result!.dependencies[0].name).toBe("valid-pkg");
      expect(result!.warnings).toContain("components[0]: missing or empty name, skipped");
    });

    it("handles non-object entries in components array", () => {
      const doc = {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        components: [
          "not-an-object",
          null,
          { type: "library", name: "real-pkg", version: "1.0.0" },
        ],
      };

      const result = detectAndParseSbom(doc, "bom.json");

      expect(result!.dependencies).toHaveLength(1);
      expect(result!.dependencies[0].name).toBe("real-pkg");
      expect(result!.warnings).toHaveLength(2);
    });

    it("warns when components array is missing entirely", () => {
      const doc = {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
      };

      const result = detectAndParseSbom(doc, "bom.json");

      expect(result!.format).toBe("cyclonedx");
      expect(result!.dependencies).toEqual([]);
      expect(result!.warnings).toContain("CycloneDX document has no components array");
    });

    it("ignores extra unexpected fields", () => {
      const doc = {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        serialNumber: "urn:uuid:abc123",
        metadata: { timestamp: "2024-01-01T00:00:00Z" },
        components: [
          {
            type: "library",
            name: "express",
            version: "4.18.2",
            purl: "pkg:npm/express@4.18.2",
            hashes: [{ alg: "SHA-256", content: "abc" }],
            licenses: [{ expression: "MIT" }],
            extraneous: true,
          },
        ],
      };

      const result = detectAndParseSbom(doc, "bom.json");

      expect(result!.dependencies).toHaveLength(1);
      expect(result!.dependencies[0].name).toBe("express");
      expect(result!.warnings).toEqual([]);
    });

    it("detects ecosystem from purl", () => {
      const doc = {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        components: [
          { name: "flask", version: "2.3.2", purl: "pkg:pypi/flask@2.3.2" },
          { name: "guava", version: "31.1", purl: "pkg:maven/com.google.guava/guava@31.1" },
          { name: "rails", version: "7.0.0", purl: "pkg:gem/rails@7.0.0" },
          { name: "no-purl", version: "1.0.0" },
        ],
      };

      const result = detectAndParseSbom(doc, "bom.json");

      expect(result!.dependencies[0].ecosystem).toBe("pypi");
      expect(result!.dependencies[1].ecosystem).toBe("maven");
      expect(result!.dependencies[2].ecosystem).toBe("gem");
      expect(result!.dependencies[3].ecosystem).toBe("npm");
    });

    it("is case-insensitive on bomFormat value", () => {
      const doc = {
        bomFormat: "cyclonedx",
        specVersion: "1.5",
        components: [{ name: "pkg", version: "1.0.0" }],
      };

      const result = detectAndParseSbom(doc, "bom.json");
      expect(result!.format).toBe("cyclonedx");
    });
  });

  describe("SPDX", () => {
    it("parses a valid SPDX document", () => {
      const result = detectAndParseSbom(VALID_SPDX, "sbom.spdx.json");

      expect(result).not.toBeNull();
      expect(result!.format).toBe("spdx");
      expect(result!.warnings).toEqual([]);
      expect(result!.dependencies).toEqual([
        {
          name: "flask",
          version: "2.3.2",
          manifestFile: "sbom.spdx.json",
          ecosystem: "pypi",
        },
        {
          name: "requests",
          version: "2.31.0",
          manifestFile: "sbom.spdx.json",
          ecosystem: "pypi",
        },
      ]);
    });

    it("defaults version to unknown when versionInfo is missing", () => {
      const doc = {
        spdxVersion: "SPDX-2.3",
        packages: [{ SPDXID: "SPDXRef-Package", name: "mystery" }],
      };

      const result = detectAndParseSbom(doc, "sbom.json");

      expect(result!.format).toBe("spdx");
      expect(result!.dependencies[0].version).toBe("unknown");
      expect(result!.warnings).toContain(
        'packages[0] (mystery): missing versionInfo, defaulting to "unknown"',
      );
    });

    it("skips packages with missing name and warns", () => {
      const doc = {
        spdxVersion: "SPDX-2.3",
        packages: [
          { SPDXID: "SPDXRef-1", versionInfo: "1.0.0" },
          { SPDXID: "SPDXRef-2", name: "valid", versionInfo: "2.0.0" },
        ],
      };

      const result = detectAndParseSbom(doc, "sbom.json");

      expect(result!.dependencies).toHaveLength(1);
      expect(result!.dependencies[0].name).toBe("valid");
      expect(result!.warnings).toContain("packages[0]: missing or empty name, skipped");
    });

    it("warns when packages array is missing entirely", () => {
      const doc = {
        spdxVersion: "SPDX-2.3",
        dataLicense: "CC0-1.0",
      };

      const result = detectAndParseSbom(doc, "sbom.json");

      expect(result!.format).toBe("spdx");
      expect(result!.dependencies).toEqual([]);
      expect(result!.warnings).toContain("SPDX document has no packages array");
    });

    it("ignores extra unexpected fields", () => {
      const doc = {
        spdxVersion: "SPDX-2.3",
        dataLicense: "CC0-1.0",
        creationInfo: { created: "2024-01-01T00:00:00Z" },
        packages: [
          {
            SPDXID: "SPDXRef-1",
            name: "flask",
            versionInfo: "2.3.2",
            supplier: "Organization: PyPI",
            downloadLocation: "https://example.com",
            checksums: [{ algorithm: "SHA256", checksumValue: "abc" }],
          },
        ],
      };

      const result = detectAndParseSbom(doc, "sbom.json");

      expect(result!.dependencies).toHaveLength(1);
      expect(result!.dependencies[0].name).toBe("flask");
      expect(result!.warnings).toEqual([]);
    });

    it("detects ecosystem from externalRefs purl", () => {
      const doc = {
        spdxVersion: "SPDX-2.3",
        packages: [
          {
            name: "guava",
            versionInfo: "31.1",
            externalRefs: [
              {
                referenceCategory: "PACKAGE-MANAGER",
                referenceType: "purl",
                referenceLocator: "pkg:maven/com.google.guava/guava@31.1",
              },
            ],
          },
        ],
      };

      const result = detectAndParseSbom(doc, "sbom.json");
      expect(result!.dependencies[0].ecosystem).toBe("maven");
    });
  });

  describe("unknown / invalid input", () => {
    it("returns null for a plain JSON object with no SBOM markers", () => {
      const doc = { name: "my-project", version: "1.0.0", dependencies: {} };
      expect(detectAndParseSbom(doc, "bom.json")).toBeNull();
    });

    it("returns null for null input", () => {
      expect(detectAndParseSbom(null, "bom.json")).toBeNull();
    });

    it("returns null for an array", () => {
      expect(detectAndParseSbom([1, 2, 3], "bom.json")).toBeNull();
    });

    it("returns null for a string", () => {
      expect(detectAndParseSbom("not an object" as unknown, "bom.json")).toBeNull();
    });

    it("returns null for a number", () => {
      expect(detectAndParseSbom(42 as unknown, "bom.json")).toBeNull();
    });

    it("returns null when bomFormat is present but not CycloneDX", () => {
      const doc = { bomFormat: "NotCycloneDX", components: [] };
      expect(detectAndParseSbom(doc, "bom.json")).toBeNull();
    });

    it("returns null when spdxVersion does not start with SPDX-", () => {
      const doc = { spdxVersion: "2.3", packages: [] };
      expect(detectAndParseSbom(doc, "sbom.json")).toBeNull();
    });
  });
});
