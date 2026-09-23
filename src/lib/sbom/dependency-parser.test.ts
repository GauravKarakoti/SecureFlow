import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isSupportedManifest,
  isSbomManifest,
  normalizeNpmVersion,
  parseManifestFile,
  SUPPORTED_MANIFESTS,
} from "./dependency-parser";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeNpmVersion", () => {
  it.each([
    ["^1.2.3", "1.2.3"],
    ["~1.2.3", "1.2.3"],
    ["1.2.3", "1.2.3"],
    ["  ^2.0.0  ", "2.0.0"],
    ["v1.2.3", "1.2.3"],
    ["1.2.3-beta.1", "1.2.3-beta.1"],
    ["4", "4"],
  ])("reads a concrete version out of %s", (specifier, expected) => {
    expect(normalizeNpmVersion(specifier)).toBe(expected);
  });

  it.each([
    [">=1.2.3", "1.2.3"],
    [">1.2.3", "1.2.3"],
    [">= 1.2.3 <2.0.0", "1.2.3"],
    ["<2.0.0 >=1.2.3", "1.2.3"],
  ])("takes the lower bound of the range %s", (specifier, expected) => {
    // Stripping one leading character turned these into "=1.2.3" and
    // "= 1.2.3 <2.0.0" — strings OSV matches against nothing, so the dependency
    // came back clean.
    expect(normalizeNpmVersion(specifier)).toBe(expected);
  });

  it("does not treat an exclusive upper bound as the installed version", () => {
    // `<4.17.21` says the package is on something below 4.17.21. The old rule
    // dropped the operator and asked OSV about 4.17.21 itself.
    expect(normalizeNpmVersion("<4.17.21")).toBe("unknown");
    // `<=` does allow that version, so it stands as the upper end of the range.
    expect(normalizeNpmVersion("<=4.17.21")).toBe("4.17.21");
  });

  it.each([
    ["*", "no version at all"],
    ["", "an empty specifier"],
    ["latest", "a dist-tag"],
    ["1.x", "a wildcard range"],
    ["1.2.*", "a wildcard patch"],
    ["npm:lodash@^4.17.21", "an alias, whose name is not this dependency's"],
    ["file:../local-copy", "a local path"],
    ["link:../sibling", "a workspace link"],
    ["workspace:*", "a workspace protocol"],
    ["github:owner/repo#v1.2.3", "a GitHub shorthand"],
    ["git+https://example.com/x.git", "a git URL"],
    ["https://example.com/x.tgz", "a tarball URL"],
  ])("reports %s as unknown (%s)", (specifier) => {
    expect(normalizeNpmVersion(specifier)).toBe("unknown");
  });
});

describe("isSupportedManifest", () => {
  it("accepts the supported manifests anywhere in the tree", () => {
    expect(isSupportedManifest("package.json")).toBe(true);
    expect(isSupportedManifest("services/api/package.json")).toBe(true);
    expect(isSupportedManifest("requirements.txt")).toBe(true);
  });

  it("accepts SBOM standard filenames", () => {
    expect(isSupportedManifest("bom.json")).toBe(true);
    expect(isSupportedManifest("sbom.json")).toBe(true);
    expect(isSupportedManifest("output.cdx.json")).toBe(true);
    expect(isSupportedManifest("output.spdx.json")).toBe(true);
    expect(isSupportedManifest("path/to/bom.json")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isSupportedManifest("pom.xml")).toBe(false);
    expect(isSupportedManifest("package.json.bak")).toBe(false);
    expect(isSupportedManifest("")).toBe(false);
    expect(isSupportedManifest("tsconfig.json")).toBe(false);
    expect(isSupportedManifest("data.json")).toBe(false);
  });

  it("lists exactly what it accepts", () => {
    for (const name of SUPPORTED_MANIFESTS) {
      expect(isSupportedManifest(name)).toBe(true);
    }
  });
});

describe("isSbomManifest", () => {
  it("identifies SBOM filenames", () => {
    expect(isSbomManifest("bom.json")).toBe(true);
    expect(isSbomManifest("sbom.json")).toBe(true);
    expect(isSbomManifest("app.cdx.json")).toBe(true);
    expect(isSbomManifest("app.spdx.json")).toBe(true);
  });

  it("does not match package.json or requirements.txt", () => {
    expect(isSbomManifest("package.json")).toBe(false);
    expect(isSbomManifest("requirements.txt")).toBe(false);
  });
});

describe("parseManifestFile — package.json", () => {
  it("normalises every specifier it keeps", () => {
    const content = JSON.stringify({
      dependencies: {
        pinned: "1.2.3",
        caret: "^4.17.20",
        atLeast: ">=2.1.0",
        below: "<9.9.9",
        aliased: "npm:other@^1.0.0",
        wildcard: "*",
      },
      devDependencies: { tilde: "~7.0.1" },
    });

    const deps = parseManifestFile(content, "package.json");
    const byName = Object.fromEntries(deps.map((d) => [d.name, d.version]));

    expect(byName).toEqual({
      pinned: "1.2.3",
      caret: "4.17.20",
      atLeast: "2.1.0",
      below: "unknown",
      aliased: "unknown",
      wildcard: "unknown",
      tilde: "7.0.1",
    });
    expect(deps.every((d) => d.ecosystem === "npm")).toBe(true);
    expect(deps.every((d) => d.manifestFile === "package.json")).toBe(true);
  });

  it("skips non-string specifiers instead of crashing", () => {
    const content = JSON.stringify({ dependencies: { good: "^1.0.0", bad: { version: "1.0.0" } } });

    expect(parseManifestFile(content, "package.json")).toEqual([
      { name: "good", version: "1.0.0", manifestFile: "package.json", ecosystem: "npm" },
    ]);
  });

  it("returns nothing for invalid JSON", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseManifestFile("{ not json", "package.json")).toEqual([]);
  });

  it("returns nothing when there are no dependency blocks", () => {
    expect(parseManifestFile(JSON.stringify({ name: "x" }), "package.json")).toEqual([]);
  });
});

describe("parseManifestFile — requirements.txt", () => {
  it("reads pins and leaves unpinned packages unknown", () => {
    const content = ["# a comment", "", "Django==3.2.4", "requests>=2.0", "flask"].join("\n");

    expect(parseManifestFile(content, "requirements.txt")).toEqual([
      { name: "django", version: "3.2.4", manifestFile: "requirements.txt", ecosystem: "pypi" },
      { name: "requests", version: "2.0", manifestFile: "requirements.txt", ecosystem: "pypi" },
      { name: "flask", version: "unknown", manifestFile: "requirements.txt", ecosystem: "pypi" },
    ]);
  });
});

describe("parseManifestFile — CycloneDX SBOM", () => {
  it("extracts dependencies from a valid CycloneDX document", () => {
    const content = JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [
        { name: "express", version: "4.18.2", purl: "pkg:npm/express@4.18.2" },
        { name: "lodash", version: "4.17.21", purl: "pkg:npm/lodash@4.17.21" },
      ],
    });

    const deps = parseManifestFile(content, "bom.json");

    expect(deps).toHaveLength(2);
    expect(deps[0]).toEqual({
      name: "express",
      version: "4.18.2",
      manifestFile: "bom.json",
      ecosystem: "npm",
    });
  });

  it("returns empty for invalid JSON in SBOM file", () => {
    expect(parseManifestFile("{ not json", "bom.json")).toEqual([]);
  });

  it("returns empty for JSON that is not CycloneDX or SPDX", () => {
    const content = JSON.stringify({ random: "data" });
    expect(parseManifestFile(content, "bom.json")).toEqual([]);
  });
});

describe("parseManifestFile — SPDX SBOM", () => {
  it("extracts dependencies from a valid SPDX document", () => {
    const content = JSON.stringify({
      spdxVersion: "SPDX-2.3",
      packages: [
        {
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
      ],
    });

    const deps = parseManifestFile(content, "output.spdx.json");

    expect(deps).toHaveLength(1);
    expect(deps[0]).toEqual({
      name: "flask",
      version: "2.3.2",
      manifestFile: "output.spdx.json",
      ecosystem: "pypi",
    });
  });
});

describe("parseManifestFile — unsupported", () => {
  it("returns nothing rather than guessing", () => {
    expect(parseManifestFile("<project/>", "pom.xml")).toEqual([]);
  });
});
