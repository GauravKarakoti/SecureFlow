import crypto from "node:crypto";
import type { Dependency } from "@/types/sbom";

/**
 * CycloneDX 1.5 & SPDX 2.3 SBOM Exporter (#2189).
 *
 * Generates standards-compliant SBOM JSON documents with canonical PURLs,
 * SPDX license expressions, and transitive dependency graph relationships
 * that round-trip cleanly through `detectAndParseSbom`.
 */

export interface SbomExportMetadata {
  projectName: string;
  projectVersion?: string;
  timestamp?: string;
  toolVersion?: string;
}

const ECOSYSTEM_TO_PURL_TYPE: Record<Dependency["ecosystem"], string> = {
  npm: "npm",
  pypi: "pypi",
  maven: "maven",
  gem: "gem",
  cargo: "cargo",
  go: "golang",
};

/**
 * Builds a canonical Package URL (PURL) for any SecureFlow `Dependency`.
 */
export function buildPackagePurl(dep: Dependency): string {
  const purlType = ECOSYSTEM_TO_PURL_TYPE[dep.ecosystem] ?? dep.ecosystem;
  let pathPart: string;

  if (dep.ecosystem === "maven" && dep.name.includes(":")) {
    const [groupId, artifactId] = dep.name.split(":", 2);
    pathPart = `${encodeURIComponent(groupId!)}/${encodeURIComponent(artifactId!)}`;
  } else if (dep.ecosystem === "npm" && dep.name.startsWith("@") && dep.name.includes("/")) {
    const [scope, pkg] = dep.name.split("/", 2);
    pathPart = `${encodeURIComponent(scope!)}/${encodeURIComponent(pkg!)}`;
  } else if (dep.ecosystem === "go") {
    pathPart = dep.name
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
  } else {
    pathPart = encodeURIComponent(dep.name);
  }

  const versionPart =
    dep.version && dep.version !== "unknown" ? `@${encodeURIComponent(dep.version)}` : "";
  return `pkg:${purlType}/${pathPart}${versionPart}`;
}

function makeBomRef(dep: Dependency, idx: number): string {
  return `${dep.ecosystem}:${dep.name}@${dep.version}#${idx}`;
}

function makeSpdxId(dep: Dependency, idx: number): string {
  const safe = `${dep.ecosystem}-${dep.name}-${dep.version}`.replace(/[^A-Za-z0-9.-]/g, "-");
  return `SPDXRef-Package-${safe}-${idx}`;
}

/**
 * Exports dependencies as a CycloneDX v1.5 JSON document.
 */
export function exportCycloneDxBom(
  dependencies: readonly Dependency[],
  metadata: SbomExportMetadata,
): Record<string, unknown> {
  const timestamp = metadata.timestamp ?? new Date().toISOString();
  const rootRef = `root:${metadata.projectName}@${metadata.projectVersion ?? "1.0.0"}`;

  const refByName = new Map<string, string>();
  const components = dependencies.map((dep, idx) => {
    const bomRef = makeBomRef(dep, idx);
    refByName.set(dep.name, bomRef);
    const purl = buildPackagePurl(dep);

    return {
      type: "library",
      "bom-ref": bomRef,
      name: dep.name,
      version: dep.version,
      purl,
      scope: dep.isTransitive ? "optional" : "required",
      ...(dep.license ? { licenses: [{ expression: dep.license }] } : {}),
    };
  });

  // Build dependency graph edges
  const childrenByParent = new Map<string, string[]>();
  const directRefs: string[] = [];

  dependencies.forEach((dep, idx) => {
    const ref = makeBomRef(dep, idx);
    if (dep.parentPackage && refByName.has(dep.parentPackage)) {
      const parentRef = refByName.get(dep.parentPackage)!;
      const list = childrenByParent.get(parentRef) ?? [];
      list.push(ref);
      childrenByParent.set(parentRef, list);
    } else if (!dep.isTransitive) {
      directRefs.push(ref);
    }
  });

  const dependencyGraph: Array<{ ref: string; dependsOn: string[] }> = [
    { ref: rootRef, dependsOn: directRefs },
  ];
  for (const [parentRef, children] of childrenByParent) {
    dependencyGraph.push({ ref: parentRef, dependsOn: children });
  }

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp,
      tools: [
        {
          vendor: "SecureFlow",
          name: "secureflow-sbom-exporter",
          version: metadata.toolVersion ?? "1.0.0",
        },
      ],
      component: {
        type: "application",
        "bom-ref": rootRef,
        name: metadata.projectName,
        version: metadata.projectVersion ?? "1.0.0",
      },
    },
    components,
    dependencies: dependencyGraph,
  };
}

/**
 * Exports dependencies as an SPDX v2.3 JSON document.
 */
export function exportSpdxDocument(
  dependencies: readonly Dependency[],
  metadata: SbomExportMetadata,
): Record<string, unknown> {
  const timestamp = metadata.timestamp ?? new Date().toISOString();
  const docId = "SPDXRef-DOCUMENT";

  const spdxIdByName = new Map<string, string>();
  const packages = dependencies.map((dep, idx) => {
    const spdxId = makeSpdxId(dep, idx);
    spdxIdByName.set(dep.name, spdxId);
    const purl = buildPackagePurl(dep);
    const license = dep.license ?? "NOASSERTION";

    return {
      SPDXID: spdxId,
      name: dep.name,
      versionInfo: dep.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: license,
      licenseDeclared: license,
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: purl,
        },
      ],
    };
  });

  const relationships: Array<{
    spdxElementId: string;
    relationshipType: string;
    relatedSpdxElement: string;
  }> = [];

  dependencies.forEach((dep, idx) => {
    const pkgId = makeSpdxId(dep, idx);
    if (!dep.isTransitive) {
      relationships.push({
        spdxElementId: docId,
        relationshipType: "DESCRIBES",
        relatedSpdxElement: pkgId,
      });
    }
    if (dep.parentPackage && spdxIdByName.has(dep.parentPackage)) {
      relationships.push({
        spdxElementId: spdxIdByName.get(dep.parentPackage)!,
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: pkgId,
      });
    }
  });

  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: docId,
    name: `${metadata.projectName}-sbom`,
    documentNamespace: `https://secureflow.dev/spdx/${encodeURIComponent(metadata.projectName)}/${crypto.randomUUID()}`,
    creationInfo: {
      created: timestamp,
      creators: [`Tool: secureflow-sbom-exporter-${metadata.toolVersion ?? "1.0.0"}`],
    },
    packages,
    relationships,
  };
}
