import type { Dependency } from "@/types/sbom";

export type SbomFormat = "cyclonedx" | "spdx";

export interface SbomDetectionResult {
  format: SbomFormat;
  dependencies: Dependency[];
  warnings: string[];
}

const PURL_ECOSYSTEM: Record<string, Dependency["ecosystem"]> = {
  npm: "npm",
  pypi: "pypi",
  maven: "maven",
  gem: "gem",
};

function ecosystemFromPurl(purl: string): Dependency["ecosystem"] | null {
  const match = purl.match(/^pkg:([^/]+)\//);
  if (!match) return null;
  return PURL_ECOSYSTEM[match[1].toLowerCase()] ?? null;
}

function isCycloneDx(doc: Record<string, unknown>): boolean {
  return typeof doc.bomFormat === "string" && doc.bomFormat.toLowerCase() === "cyclonedx";
}

function isSpdx(doc: Record<string, unknown>): boolean {
  return typeof doc.spdxVersion === "string" && (doc.spdxVersion as string).startsWith("SPDX-");
}

function parseCycloneDxComponents(
  doc: Record<string, unknown>,
  fileName: string,
): { dependencies: Dependency[]; warnings: string[] } {
  const warnings: string[] = [];
  const dependencies: Dependency[] = [];

  const components = doc.components;
  if (!Array.isArray(components)) {
    warnings.push("CycloneDX document has no components array");
    return { dependencies, warnings };
  }

  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    if (typeof comp !== "object" || comp === null || Array.isArray(comp)) {
      warnings.push(`components[${i}]: not an object, skipped`);
      continue;
    }

    const c = comp as Record<string, unknown>;
    if (typeof c.name !== "string" || c.name.trim() === "") {
      warnings.push(`components[${i}]: missing or empty name, skipped`);
      continue;
    }

    const name = c.name.trim();
    let version = "unknown";
    if (typeof c.version === "string" && c.version.trim() !== "") {
      version = c.version.trim();
    } else {
      warnings.push(`components[${i}] (${name}): missing version, defaulting to "unknown"`);
    }

    let ecosystem: Dependency["ecosystem"] = "npm";
    if (typeof c.purl === "string") {
      const detected = ecosystemFromPurl(c.purl);
      if (detected) {
        ecosystem = detected;
      }
    }

    dependencies.push({ name, version, manifestFile: fileName, ecosystem });
  }

  return { dependencies, warnings };
}

function parseSpdxPackages(
  doc: Record<string, unknown>,
  fileName: string,
): { dependencies: Dependency[]; warnings: string[] } {
  const warnings: string[] = [];
  const dependencies: Dependency[] = [];

  const packages = doc.packages;
  if (!Array.isArray(packages)) {
    warnings.push("SPDX document has no packages array");
    return { dependencies, warnings };
  }

  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i];
    if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
      warnings.push(`packages[${i}]: not an object, skipped`);
      continue;
    }

    const p = pkg as Record<string, unknown>;
    if (typeof p.name !== "string" || p.name.trim() === "") {
      warnings.push(`packages[${i}]: missing or empty name, skipped`);
      continue;
    }

    const name = p.name.trim();
    let version = "unknown";
    if (typeof p.versionInfo === "string" && p.versionInfo.trim() !== "") {
      version = p.versionInfo.trim();
    } else {
      warnings.push(`packages[${i}] (${name}): missing versionInfo, defaulting to "unknown"`);
    }

    let ecosystem: Dependency["ecosystem"] = "npm";
    const externalRefs = p.externalRefs;
    if (Array.isArray(externalRefs)) {
      for (const ref of externalRefs) {
        if (
          typeof ref === "object" &&
          ref !== null &&
          typeof (ref as Record<string, unknown>).referenceLocator === "string"
        ) {
          const locator = (ref as Record<string, unknown>).referenceLocator as string;
          if (locator.startsWith("pkg:")) {
            const detected = ecosystemFromPurl(locator);
            if (detected) {
              ecosystem = detected;
              break;
            }
          }
        }
      }
    }

    dependencies.push({ name, version, manifestFile: fileName, ecosystem });
  }

  return { dependencies, warnings };
}

/**
 * Detect whether a parsed JSON document is a CycloneDX or SPDX SBOM and
 * extract dependencies from it.
 *
 * Returns null if the document matches neither format.
 */
export function detectAndParseSbom(doc: unknown, fileName: string): SbomDetectionResult | null {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return null;
  }

  const obj = doc as Record<string, unknown>;

  if (isCycloneDx(obj)) {
    const { dependencies, warnings } = parseCycloneDxComponents(obj, fileName);
    return { format: "cyclonedx", dependencies, warnings };
  }

  if (isSpdx(obj)) {
    const { dependencies, warnings } = parseSpdxPackages(obj, fileName);
    return { format: "spdx", dependencies, warnings };
  }

  return null;
}
