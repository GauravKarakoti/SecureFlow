/**
 * Monorepo Policy Scoping (`policyScopes` in `.secureflow.json`).
 *
 * Allows different directories/paths in a monorepo to receive different security policies
 * (e.g. Terraform folder gets infrastructure policies, tests folder ignores production secret checks).
 *
 * Implements Issue #1868.
 */

import { compileIgnorePatterns } from "@/lib/armor/scanner";
import { normalizeGatePath } from "@/lib/armor/iq";

export interface PolicyScopeRule {
  paths: string[];
  enable?: string[];
  disable?: string[];
}

export interface AppliedScopeSummary {
  scope: PolicyScopeRule;
  matchedFiles: string[];
}

export interface ParsePolicyScopesResult {
  scopes: PolicyScopeRule[];
  warnings: string[];
}

export interface ScopedFileGroup<
  T,
  F extends { filename: string; patch?: string } = { filename: string; patch?: string },
> {
  key: string;
  files: F[];
  policies: T[];
  appliedScopes: PolicyScopeRule[];
}

/**
 * Validates whether a glob string is a non-empty, valid glob pattern that compiles.
 */
export function isValidGlob(glob: unknown): glob is string {
  if (typeof glob !== "string") return false;
  const trimmed = glob.trim();
  if (trimmed.length === 0) return false;
  try {
    const compiled = compileIgnorePatterns([trimmed]);
    return compiled.length > 0 && compiled[0] instanceof RegExp;
  } catch {
    return false;
  }
}

/**
 * Parses raw JSON / object value for `policyScopes` from `.secureflow.json`.
 *
 * Safety guarantees:
 * - A missing, non-array, or invalid top-level value safely returns empty scopes with a warning.
 * - Malformed entries, invalid globs, and unknown policy names are skipped with a warning.
 * - Never throws an error or fails the scan.
 */
export function parsePolicyScopes(
  raw: unknown,
  knownPolicyNames?: string[],
): ParsePolicyScopesResult {
  const warnings: string[] = [];

  if (raw === undefined || raw === null) {
    return { scopes: [], warnings };
  }

  if (!Array.isArray(raw)) {
    const msg = `[PolicyScopes] 'policyScopes' in .secureflow.json must be an array; ignoring.`;
    warnings.push(msg);
    console.warn(msg);
    return { scopes: [], warnings };
  }

  const scopes: PolicyScopeRule[] = [];

  raw.forEach((entry, index) => {
    const label = `policyScopes[${index}]`;

    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      const msg = `[PolicyScopes] ${label} must be an object; skipping this entry.`;
      warnings.push(msg);
      console.warn(msg);
      return;
    }

    const obj = entry as Record<string, unknown>;

    // 1. Validate paths
    if (!Array.isArray(obj.paths) || obj.paths.length === 0) {
      const msg = `[PolicyScopes] ${label} must specify a non-empty 'paths' array; skipping this entry.`;
      warnings.push(msg);
      console.warn(msg);
      return;
    }

    const validPaths: string[] = [];
    for (const p of obj.paths) {
      if (isValidGlob(p)) {
        validPaths.push((p as string).trim());
      } else {
        const msg = `[PolicyScopes] ${label} has invalid glob '${String(p)}'; skipping this glob.`;
        warnings.push(msg);
        console.warn(msg);
      }
    }

    if (validPaths.length === 0) {
      const msg = `[PolicyScopes] ${label} has no valid globs in 'paths'; skipping this entry.`;
      warnings.push(msg);
      console.warn(msg);
      return;
    }

    // 2. Validate enable & disable
    const rawEnable = obj.enable;
    const rawDisable = obj.disable;

    if (
      (rawEnable === undefined || rawEnable === null) &&
      (rawDisable === undefined || rawDisable === null)
    ) {
      const msg = `[PolicyScopes] ${label} must specify either an 'enable' or 'disable' list; skipping this entry.`;
      warnings.push(msg);
      console.warn(msg);
      return;
    }

    let validEnable: string[] | undefined = undefined;
    if (rawEnable !== undefined && rawEnable !== null) {
      if (!Array.isArray(rawEnable)) {
        const msg = `[PolicyScopes] 'enable' in ${label} must be an array; skipping 'enable'.`;
        warnings.push(msg);
        console.warn(msg);
      } else {
        validEnable = [];
        for (const item of rawEnable) {
          if (typeof item !== "string" || !item.trim()) {
            const msg = `[PolicyScopes] ${label} contains non-string or empty policy in 'enable'; skipping.`;
            warnings.push(msg);
            console.warn(msg);
            continue;
          }
          const trimmed = item.trim();
          if (knownPolicyNames && knownPolicyNames.length > 0) {
            const isKnown = knownPolicyNames.some((k) => k.toLowerCase() === trimmed.toLowerCase());
            if (!isKnown) {
              const msg = `[PolicyScopes] Unknown policy name '${trimmed}' in ${label}.enable; ignoring.`;
              warnings.push(msg);
              console.warn(msg);
              continue;
            }
          }
          validEnable.push(trimmed);
        }
      }
    }

    let validDisable: string[] | undefined = undefined;
    if (rawDisable !== undefined && rawDisable !== null) {
      if (!Array.isArray(rawDisable)) {
        const msg = `[PolicyScopes] 'disable' in ${label} must be an array; skipping 'disable'.`;
        warnings.push(msg);
        console.warn(msg);
      } else {
        validDisable = [];
        for (const item of rawDisable) {
          if (typeof item !== "string" || !item.trim()) {
            const msg = `[PolicyScopes] ${label} contains non-string or empty policy in 'disable'; skipping.`;
            warnings.push(msg);
            console.warn(msg);
            continue;
          }
          const trimmed = item.trim();
          if (knownPolicyNames && knownPolicyNames.length > 0) {
            const isKnown = knownPolicyNames.some((k) => k.toLowerCase() === trimmed.toLowerCase());
            if (!isKnown) {
              const msg = `[PolicyScopes] Unknown policy name '${trimmed}' in ${label}.disable; ignoring.`;
              warnings.push(msg);
              console.warn(msg);
              continue;
            }
          }
          validDisable.push(trimmed);
        }
      }
    }

    if (!validEnable?.length && !validDisable?.length) {
      const msg = `[PolicyScopes] ${label} has no valid policy names in 'enable' or 'disable'; skipping this entry.`;
      warnings.push(msg);
      console.warn(msg);
      return;
    }

    scopes.push({
      paths: validPaths,
      ...(validEnable && validEnable.length > 0 ? { enable: validEnable } : {}),
      ...(validDisable && validDisable.length > 0 ? { disable: validDisable } : {}),
    });
  });

  return { scopes, warnings };
}

/**
 * Resolves the applicable policy list for a specific file based on active policies and policyScopes.
 * Handles conflicting scopes in file-definition order.
 */
export function resolvePoliciesForFile<T extends { name?: string; description?: string }>(
  filename: string,
  activePolicies: readonly T[],
  scopes?: readonly PolicyScopeRule[],
): {
  policies: T[];
  appliedScopes: PolicyScopeRule[];
} {
  if (!scopes || scopes.length === 0) {
    return { policies: [...activePolicies], appliedScopes: [] };
  }

  const normalized = normalizeGatePath(filename);
  const matchedScopes: PolicyScopeRule[] = [];

  for (const scope of scopes) {
    try {
      const regexes = compileIgnorePatterns(scope.paths);
      if (regexes.some((re) => re.test(normalized))) {
        matchedScopes.push(scope);
      }
    } catch {
      // Ignore pattern matching errors
    }
  }

  if (matchedScopes.length === 0) {
    return { policies: [...activePolicies], appliedScopes: [] };
  }

  // Start with full active policies
  let current = [...activePolicies];

  for (const scope of matchedScopes) {
    if (scope.enable && scope.enable.length > 0) {
      const enabledLower = new Set(scope.enable.map((e) => e.toLowerCase()));
      current = activePolicies.filter((p) => {
        const name = (p.name || p.description || "").toLowerCase();
        return enabledLower.has(name);
      });
    }

    if (scope.disable && scope.disable.length > 0) {
      const disabledLower = new Set(scope.disable.map((d) => d.toLowerCase()));
      current = current.filter((p) => {
        const name = (p.name || p.description || "").toLowerCase();
        return !disabledLower.has(name);
      });
    }
  }

  return { policies: current, appliedScopes: matchedScopes };
}

/**
 * Groups files that share identical applicable policies so they can be chunked and scanned efficiently.
 */
export function groupFilesByPolicyScope<
  T extends { name?: string; description?: string; id?: string },
  F extends { filename: string; patch?: string } = { filename: string; patch?: string },
>(
  files: F[],
  activePolicies: readonly T[],
  scopes?: readonly PolicyScopeRule[],
): ScopedFileGroup<T, F>[] {
  if (!scopes || scopes.length === 0) {
    return [
      {
        key: "default",
        files: [...files],
        policies: [...activePolicies],
        appliedScopes: [],
      },
    ];
  }

  const groups = new Map<string, ScopedFileGroup<T, F>>();

  for (const file of files) {
    const { policies, appliedScopes } = resolvePoliciesForFile(
      file.filename,
      activePolicies,
      scopes,
    );
    const key = policies
      .map((p) => p.name || p.id || p.description || "")
      .sort()
      .join("|");

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        files: [],
        policies,
        appliedScopes,
      });
    }

    groups.get(key)!.files.push(file);
  }

  return Array.from(groups.values());
}

/**
 * Collects which scopes were actually matched against the changed files for reporting in PR comments.
 */
export function collectAppliedScopes(
  files: Array<{ filename: string }>,
  scopes?: readonly PolicyScopeRule[],
): AppliedScopeSummary[] {
  if (!scopes || scopes.length === 0 || files.length === 0) return [];

  const results: AppliedScopeSummary[] = [];

  for (const scope of scopes) {
    try {
      const regexes = compileIgnorePatterns(scope.paths);
      const matched = files
        .map((f) => normalizeGatePath(f.filename))
        .filter((path) => regexes.some((re) => re.test(path)));

      if (matched.length > 0) {
        results.push({
          scope,
          matchedFiles: matched,
        });
      }
    } catch {
      // Ignore pattern matching errors
    }
  }

  return results;
}

/**
 * Formats a Markdown section describing which policy scopes were applied, for the PR comment.
 */
export function formatAppliedScopesSection(
  appliedSummaries: readonly AppliedScopeSummary[],
): string {
  if (!appliedSummaries || appliedSummaries.length === 0) return "";

  let out = `### 📁 Policy Scopes Applied (${appliedSummaries.length})\n\n`;
  for (const { scope, matchedFiles } of appliedSummaries) {
    const pathGlobs = scope.paths.map((p) => `\`${p}\``).join(", ");
    const fileCount = matchedFiles.length;
    const filesText = `(${fileCount} file${fileCount === 1 ? "" : "s"})`;

    const parts: string[] = [];
    if (scope.enable && scope.enable.length > 0) {
      parts.push(`Enabled **${scope.enable.join("**, **")}**`);
    }
    if (scope.disable && scope.disable.length > 0) {
      parts.push(`Disabled **${scope.disable.join("**, **")}**`);
    }

    out += `- ${pathGlobs}: ${parts.join("; ")} ${filesText}\n`;
  }
  out += `\n`;
  return out;
}
