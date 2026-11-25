/**
 * Deterministic SBOM Snapshot Diffing & Supply-Chain Drift Analyzer (#2110).
 *
 * Compares base and head dependency snapshots to detect:
 * - Added and removed packages
 * - Semver upgrades and unexpected version downgrades
 * - License compliance regressions (e.g., MIT -> GPL-3.0-only)
 */

import type { Dependency } from "@/types/sbom";
import { compareVersions } from "./version-compare";
import {
  evaluateLicensePolicy,
  STANDARD_OSS_POLICY,
  type LicenseEvaluationResult,
  type LicensePolicyConfig,
} from "./spdx-license-policy";

export interface DependencyChange {
  ecosystem: Dependency["ecosystem"];
  name: string;
  baseVersion: string;
  headVersion: string;
  baseLicense?: string;
  headLicense?: string;
}

export interface LicenseRegression {
  ecosystem: Dependency["ecosystem"];
  name: string;
  version: string;
  previousLicense?: string;
  newLicense: string;
  evaluation: LicenseEvaluationResult;
}

export interface SbomDiffSummary {
  totalBase: number;
  totalHead: number;
  addedCount: number;
  removedCount: number;
  upgradedCount: number;
  downgradedCount: number;
  unchangedCount: number;
  licenseRegressionCount: number;
}

export interface SbomDiffResult {
  added: Dependency[];
  removed: Dependency[];
  upgraded: DependencyChange[];
  downgraded: DependencyChange[];
  unchanged: Dependency[];
  licenseRegressions: LicenseRegression[];
  summary: SbomDiffSummary;
}

function depKey(dep: Dependency): string {
  return `${dep.ecosystem}:${dep.name}`;
}

function indexDependencies(deps: readonly Dependency[]): Map<string, Dependency[]> {
  const map = new Map<string, Dependency[]>();
  for (const dep of deps) {
    const key = depKey(dep);
    const list = map.get(key);
    if (list) {
      list.push(dep);
    } else {
      map.set(key, [dep]);
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => compareVersions(a.version, b.version));
  }
  return map;
}

/**
 * Computes a deterministic structural, version, and license drift diff between
 * base and head SBOM/lockfile dependency snapshots.
 */
export function diffSbomSnapshots(
  baseDeps: readonly Dependency[],
  headDeps: readonly Dependency[],
  licensePolicy: LicensePolicyConfig = STANDARD_OSS_POLICY,
): SbomDiffResult {
  const baseMap = indexDependencies(baseDeps);
  const headMap = indexDependencies(headDeps);

  const added: Dependency[] = [];
  const removed: Dependency[] = [];
  const upgraded: DependencyChange[] = [];
  const downgraded: DependencyChange[] = [];
  const unchanged: Dependency[] = [];
  const licenseRegressions: LicenseRegression[] = [];

  const allKeys = Array.from(new Set([...baseMap.keys(), ...headMap.keys()])).sort();

  for (const key of allKeys) {
    const baseList = baseMap.get(key) ?? [];
    const headList = headMap.get(key) ?? [];

    const pairCount = Math.min(baseList.length, headList.length);

    for (let i = 0; i < pairCount; i++) {
      const b = baseList[i]!;
      const h = headList[i]!;

      if (b.version === h.version) {
        unchanged.push(h);
      } else {
        const cmp = compareVersions(h.version, b.version);
        const change: DependencyChange = {
          ecosystem: h.ecosystem,
          name: h.name,
          baseVersion: b.version,
          headVersion: h.version,
          ...(b.license ? { baseLicense: b.license } : {}),
          ...(h.license ? { headLicense: h.license } : {}),
        };
        if (cmp > 0) {
          upgraded.push(change);
        } else if (cmp < 0) {
          downgraded.push(change);
        } else {
          unchanged.push(h);
        }
      }

      // Check license regression on paired dependency
      if (h.license) {
        const headEval = evaluateLicensePolicy(h.license, licensePolicy);
        const baseEval = b.license ? evaluateLicensePolicy(b.license, licensePolicy) : null;
        if (!headEval.compliant && (baseEval === null || baseEval.compliant)) {
          licenseRegressions.push({
            ecosystem: h.ecosystem,
            name: h.name,
            version: h.version,
            ...(b.license ? { previousLicense: b.license } : {}),
            newLicense: h.license,
            evaluation: headEval,
          });
        }
      }
    }

    // Remaining unmatched head entries are newly added
    for (let i = pairCount; i < headList.length; i++) {
      const h = headList[i]!;
      added.push(h);
      if (h.license) {
        const headEval = evaluateLicensePolicy(h.license, licensePolicy);
        if (!headEval.compliant) {
          licenseRegressions.push({
            ecosystem: h.ecosystem,
            name: h.name,
            version: h.version,
            newLicense: h.license,
            evaluation: headEval,
          });
        }
      }
    }

    // Remaining unmatched base entries were removed
    for (let i = pairCount; i < baseList.length; i++) {
      removed.push(baseList[i]!);
    }
  }

  return {
    added,
    removed,
    upgraded,
    downgraded,
    unchanged,
    licenseRegressions,
    summary: {
      totalBase: baseDeps.length,
      totalHead: headDeps.length,
      addedCount: added.length,
      removedCount: removed.length,
      upgradedCount: upgraded.length,
      downgradedCount: downgraded.length,
      unchangedCount: unchanged.length,
      licenseRegressionCount: licenseRegressions.length,
    },
  };
}
