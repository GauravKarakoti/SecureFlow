import type { VulnerabilityMatch } from "@/types/sbom";

/**
 * Reading dependency findings back out of `Finding` rows.
 *
 * The SBOM worker stores each vulnerable dependency as a `VULNERABILITY`
 * finding whose snippet is
 *
 *     Dependency: <name>@<version>
 *     Patched: <version | Unknown>
 *
 * There is no separate table or finding type for them, so anything that
 * rebuilds an `SbomScanResult` from the database has to recognise that shape.
 * The parser matches the one `src/lib/queue/sbomWorker.ts` uses to recover a
 * completed job; `getSbomJobStatus` in `src/lib/queue/sbomQueue.ts` had its own,
 * weaker copy, and now uses this module.
 */

/** Prefix of the snippet the worker writes for a dependency finding. */
export const DEPENDENCY_SNIPPET_PREFIX = "Dependency: ";

/**
 * The stored snippet. The name match is greedy so a scoped npm package
 * (`@scope/pkg@1.0.0`) splits at its last `@`.
 */
export const DEPENDENCY_SNIPPET = /^Dependency: (.+)@([^@\n]+)\nPatched: (.*)$/;

/**
 * Prisma `where` for findings the SBOM worker wrote, as opposed to the PR code
 * scan's secret, misconfiguration and vulnerability findings on the same pull
 * request.
 */
export const DEPENDENCY_FINDING_WHERE = {
  type: "VULNERABILITY" as const,
  codeSnippet: { startsWith: DEPENDENCY_SNIPPET_PREFIX },
};

export interface StoredDependencyFinding {
  codeSnippet?: string | null;
  explanation?: string | null;
  severity: string;
}

/** Rebuild one match from a stored dependency finding. */
export function recoveredMatch(
  finding: StoredDependencyFinding,
  fileName: string,
): VulnerabilityMatch {
  const [, name = "unknown", version = "unknown", patched] =
    DEPENDENCY_SNIPPET.exec(finding.codeSnippet ?? "") ?? [];

  return {
    dependency: {
      name,
      version,
      manifestFile: fileName,
      ecosystem: fileName.endsWith("package.json") ? "npm" : "pypi",
    },
    cveId: finding.explanation?.match(/CVE-[A-Za-z0-9-]+/)?.[0] || "CVE-UNKNOWN",
    severity: finding.severity as VulnerabilityMatch["severity"],
    description: finding.explanation || "",
    patchedVersion: patched && patched !== "Unknown" ? patched : null,
  };
}
