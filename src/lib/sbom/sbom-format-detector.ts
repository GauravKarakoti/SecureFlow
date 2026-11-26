import type { Dependency } from "@/types/sbom";
import {
  evaluateDependenciesLicenses,
  STANDARD_OSS_POLICY,
  type LicensePolicyConfig,
  type SbomLicenseComplianceSummary,
} from "./spdx-license-policy";

export type SbomFormat = "cyclonedx" | "spdx";

export interface SbomDetectionResult {
  format: SbomFormat;
  dependencies: Dependency[];
  warnings: string[];
  licenseCompliance?: SbomLicenseComplianceSummary;
}

const PURL_ECOSYSTEM: Record<string, Dependency["ecosystem"]> = {
  npm: "npm",
  pypi: "pypi",
  maven: "maven",
  gem: "gem",
};

interface PackageCoordinates {
  ecosystem: Dependency["ecosystem"];
  name: string;
}

function decodePurlSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The package name as OSV knows it, for an ecosystem where a namespace is part
 * of the name. npm scopes are `@scope/name` and Maven packages are
 * `groupId:artifactId`; for PyPI and RubyGems the name stands alone.
 */
function qualifiedName(
  ecosystem: Dependency["ecosystem"],
  namespace: string,
  name: string,
): string {
  if (!namespace) return name;
  if (ecosystem === "maven") return `${namespace}:${name}`;
  if (ecosystem === "npm") return `${namespace}/${name}`;
  return name;
}

/**
 * Ecosystem and OSV package name from a package URL
 * (`pkg:type/namespace/name@version?qualifiers#subpath`).
 *
 * A CycloneDX component's `name` (and an SPDX package's) drops the namespace:
 * `org.apache.logging.log4j:log4j-core` is `name: "log4j-core"` with the group
 * in a separate field, and `@babel/core` is `name: "core"`. Querying OSV with
 * the bare name finds nothing for the first and the wrong package for the
 * second, so the purl, which carries the full coordinates, is preferred.
 */
function coordinatesFromPurl(purl: string): PackageCoordinates | null {
  const match = purl.match(/^pkg:([^/]+)\/([^@?#]+)/);
  if (!match) return null;

  const ecosystem = PURL_ECOSYSTEM[match[1]!.toLowerCase()];
  if (!ecosystem) return null;

  const segments = match[2]!.split("/").filter(Boolean).map(decodePurlSegment);
  const name = segments.pop();
  if (!name) return null;

  return { ecosystem, name: qualifiedName(ecosystem, segments.join("/"), name) };
}

function isCycloneDx(doc: Record<string, unknown>): boolean {
  return typeof doc.bomFormat === "string" && doc.bomFormat.toLowerCase() === "cyclonedx";
}

function isSpdx(doc: Record<string, unknown>): boolean {
  return typeof doc.spdxVersion === "string" && (doc.spdxVersion as string).startsWith("SPDX-");
}

function extractCycloneDxLicense(comp: Record<string, unknown>): string | undefined {
  const licenses = comp.licenses;
  if (!Array.isArray(licenses) || licenses.length === 0) return undefined;

  const parts: string[] = [];
  for (const item of licenses) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.expression === "string" && entry.expression.trim()) {
      parts.push(entry.expression.trim());
    } else if (typeof entry.license === "object" && entry.license !== null) {
      const lic = entry.license as Record<string, unknown>;
      if (typeof lic.id === "string" && lic.id.trim()) {
        parts.push(lic.id.trim());
      } else if (typeof lic.name === "string" && lic.name.trim()) {
        parts.push(lic.name.trim());
      }
    }
  }

  if (parts.length === 0) return undefined;
  return parts.length === 1
    ? parts[0]
    : parts.map((p) => (p.includes(" ") ? `(${p})` : p)).join(" AND ");
}

function extractSpdxLicense(pkg: Record<string, unknown>): string | undefined {
  const candidates = [pkg.licenseConcluded, pkg.licenseDeclared];
  for (const cand of candidates) {
    if (typeof cand === "string") {
      const trimmed = cand.trim();
      if (trimmed && trimmed.toUpperCase() !== "NOASSERTION" && trimmed.toUpperCase() !== "NONE") {
        return trimmed;
      }
    }
  }
  return undefined;
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

    let name = c.name.trim();
    let version = "unknown";
    if (typeof c.version === "string" && c.version.trim() !== "") {
      version = c.version.trim();
    } else {
      warnings.push(`components[${i}] (${name}): missing version, defaulting to "unknown"`);
    }

    let ecosystem: Dependency["ecosystem"] = "npm";
    const fromPurl = typeof c.purl === "string" ? coordinatesFromPurl(c.purl) : null;
    if (fromPurl) {
      ({ ecosystem, name } = fromPurl);
    } else if (typeof c.group === "string" && c.group.trim() !== "") {
      // No usable purl: CycloneDX carries the npm scope or Maven groupId here.
      name = qualifiedName(ecosystem, c.group.trim(), name);
    }

    const license = extractCycloneDxLicense(c);
    dependencies.push({
      name,
      version,
      manifestFile: fileName,
      ecosystem,
      ...(license ? { license } : {}),
    });
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

    let name = p.name.trim();
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
            const detected = coordinatesFromPurl(locator);
            if (detected) {
              ({ ecosystem, name } = detected);
              break;
            }
          }
        }
      }
    }

    const license = extractSpdxLicense(p);
    dependencies.push({
      name,
      version,
      manifestFile: fileName,
      ecosystem,
      ...(license ? { license } : {}),
    });
  }

  return { dependencies, warnings };
}

/**
 * Detect whether a parsed JSON document is a CycloneDX or SPDX SBOM and
 * extract dependencies + evaluate SPDX license compliance from it.
 *
 * Returns null if the document matches neither format.
 */
export function detectAndParseSbom(
  doc: unknown,
  fileName: string,
  licensePolicy: LicensePolicyConfig = STANDARD_OSS_POLICY,
): SbomDetectionResult | null {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return null;
  }

  const obj = doc as Record<string, unknown>;

  if (isCycloneDx(obj)) {
    const { dependencies, warnings } = parseCycloneDxComponents(obj, fileName);
    return {
      format: "cyclonedx",
      dependencies,
      warnings,
      licenseCompliance: evaluateDependenciesLicenses(dependencies, licensePolicy),
    };
  }

  if (isSpdx(obj)) {
    const { dependencies, warnings } = parseSpdxPackages(obj, fileName);
    return {
      format: "spdx",
      dependencies,
      warnings,
      licenseCompliance: evaluateDependenciesLicenses(dependencies, licensePolicy),
    };
  }

  return null;
}
