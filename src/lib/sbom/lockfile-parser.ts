/**
 * Lockfile Dependency Parsers for SBOM and Supply-Chain Analysis (#2050)
 *
 * Parses resolved direct and transitive dependencies from:
 * - npm `package-lock.json` (v1, v2, and v3 specifications)
 * - pnpm `pnpm-lock.yaml` (v5, v6, and v9 specifications)
 */

import type { Dependency } from "@/types/sbom";

/**
 * Checks if a given file path is a supported lockfile.
 */
export function isLockfileManifest(filePath: string): boolean {
  return filePath.endsWith("package-lock.json") || filePath.endsWith("pnpm-lock.yaml");
}

/**
 * Extracts the clean package name from a node_modules path.
 * e.g.:
 *   "node_modules/express" -> "express"
 *   "node_modules/@types/node" -> "@types/node"
 *   "node_modules/foo/node_modules/bar" -> "bar"
 *   "node_modules/foo/node_modules/@scope/bar" -> "@scope/bar"
 */
export function extractPackageNameFromPath(packagePath: string): string {
  const match = packagePath.match(/(?:.*node_modules\/)((?:@[^/]+\/)?[^/]+)$/);
  if (match && match[1]) {
    return match[1];
  }
  return packagePath.replace(/^node_modules\//, "");
}

/**
 * Parses npm package-lock.json content across lockfileVersion 1, 2, and 3.
 */
export function parsePackageLockJson(content: string, filePath: string): Dependency[] {
  if (!content || !content.trim()) return [];

  let lock: any;
  try {
    lock = JSON.parse(content);
  } catch (error) {
    console.error(`[SBOM] Failed to parse JSON in ${filePath}:`, error);
    return [];
  }

  if (!lock || typeof lock !== "object") return [];

  const depsMap = new Map<string, Dependency>();

  // Helper to add or upgrade dependency in map (direct wins over transitive)
  const addDependency = (
    name: string,
    version: string,
    isTransitive: boolean,
    parentPackage?: string,
  ) => {
    if (!name || !version || typeof version !== "string") return;
    const cleanVersion = version.trim();
    if (!cleanVersion || cleanVersion.startsWith("file:") || cleanVersion.startsWith("link:")) {
      return;
    }

    const key = `${name}@${cleanVersion}`;
    const existing = depsMap.get(key);
    if (!existing) {
      depsMap.set(key, {
        name,
        version: cleanVersion,
        manifestFile: filePath,
        ecosystem: "npm",
        isTransitive,
        parentPackage,
      });
    } else if (existing.isTransitive && !isTransitive) {
      // Direct dependency takes precedence over transitive occurrence
      existing.isTransitive = false;
    }
  };

  // --- Lockfile v2 and v3 (packages dictionary) ---
  if (lock.packages && typeof lock.packages === "object") {
    const rootPkg = lock.packages[""] || {};
    const rootDirectDeps = new Set<string>([
      ...Object.keys(rootPkg.dependencies || {}),
      ...Object.keys(rootPkg.devDependencies || {}),
      ...Object.keys(rootPkg.optionalDependencies || {}),
      ...Object.keys(rootPkg.peerDependencies || {}),
    ]);

    for (const [pkgPath, pkgData] of Object.entries<any>(lock.packages)) {
      if (!pkgPath || pkgPath === "") continue; // Skip root project descriptor
      if (!pkgData || typeof pkgData !== "object") continue;

      const version = pkgData.version;
      if (!version || typeof version !== "string") continue;

      const name = pkgData.name || extractPackageNameFromPath(pkgPath);
      if (!name) continue;

      // Direct dependency check: resides directly under top-level node_modules/ and is in root deps
      const isTopLevelNodeModules = /^node_modules\/(?:@[^/]+\/)?[^/]+$/.test(pkgPath);
      const isDirect = isTopLevelNodeModules && rootDirectDeps.has(name);
      const isTransitive = !isDirect;

      // Extract parent package if nested inside node_modules/.../node_modules/
      const parentMatch = pkgPath.match(
        /.*node_modules\/((?:@[^/]+\/)?[^/]+)\/node_modules\/(?:@[^/]+\/)?[^/]+$/,
      );
      const parentPackage = isTransitive && parentMatch ? parentMatch[1] : undefined;

      addDependency(name, version, isTransitive, parentPackage);
    }
  }

  // --- Lockfile v1 or v2 fallback (dependencies tree) ---
  if (depsMap.size === 0 && lock.dependencies && typeof lock.dependencies === "object") {
    function walkDependenciesTree(
      tree: Record<string, any>,
      isTransitive: boolean,
      parent?: string,
    ) {
      for (const [name, depData] of Object.entries<any>(tree)) {
        if (!depData || typeof depData !== "object") continue;
        const version = depData.version;
        if (version && typeof version === "string") {
          addDependency(name, version, isTransitive, parent);
        }
        if (depData.dependencies && typeof depData.dependencies === "object") {
          walkDependenciesTree(depData.dependencies, true, name);
        }
      }
    }

    walkDependenciesTree(lock.dependencies, false);
  }

  return Array.from(depsMap.values());
}

/**
 * Parses pnpm pnpm-lock.yaml content across lockfile versions 5, 6, and 9.
 */
export function parsePnpmLockYaml(content: string, filePath: string): Dependency[] {
  if (!content || !content.trim()) return [];

  const depsMap = new Map<string, Dependency>();
  const lines = content.split(/\r?\n/);

  // 1. Collect direct dependencies
  const directDepNames = new Set<string>();
  let inDirectDepsSection = false;
  let inPackagesSection = false;
  let currentIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const lineIndent = line.search(/\S/);

    if (lineIndent === 0) {
      if (
        line.startsWith("dependencies:") ||
        line.startsWith("devDependencies:") ||
        line.startsWith("optionalDependencies:")
      ) {
        inDirectDepsSection = true;
        inPackagesSection = false;
        continue;
      } else if (line.startsWith("packages:")) {
        inPackagesSection = true;
        inDirectDepsSection = false;
        continue;
      } else {
        inDirectDepsSection = false;
        inPackagesSection = false;
      }
    }

    if (inDirectDepsSection && lineIndent > 0) {
      // Line: "  express: 4.19.2" or "  express:"
      const match = trimmed.match(/^['"]?((?:@[^/:]+\/)?[^/:]+)['"]?\s*:/);
      if (match && match[1]) {
        directDepNames.add(match[1]);
      }
    }

    if (inPackagesSection && lineIndent > 0) {
      // Lines under packages:
      // Examples:
      //   "/lodash/4.17.21:" (pnpm v5)
      //   "/@scope/helper/1.2.3:" (pnpm v5 scoped)
      //   "express@4.19.2:" (pnpm v6/v9)
      //   "express@4.19.2(debug@4.3.4):"
      //   "'@types/node@20.10.0':"
      //   "'lodash@4.17.21':"
      let keyLine = trimmed;
      if (keyLine.endsWith(":")) keyLine = keyLine.slice(0, -1).trim();
      if (
        (keyLine.startsWith("'") && keyLine.endsWith("'")) ||
        (keyLine.startsWith('"') && keyLine.endsWith('"'))
      ) {
        keyLine = keyLine.slice(1, -1).trim();
      }

      let name: string | undefined;
      let rawVersion: string | undefined;

      // Check v5 format: /name/version or /@scope/name/version
      const v5Match = keyLine.match(/^\/((?:@[^/]+\/)?[^/]+)\/([^:(]+)/);
      if (v5Match && v5Match[1] && v5Match[2]) {
        name = v5Match[1];
        rawVersion = v5Match[2];
      } else {
        // Check v6/v9 format: name@version or /name@version
        const v6Match = keyLine.replace(/^\//, "").match(/^((?:@[^@/]+\/)?[^@/]+)@([^:(]+)/);
        if (v6Match && v6Match[1] && v6Match[2]) {
          name = v6Match[1];
          rawVersion = v6Match[2];
        }
      }

      if (name && rawVersion) {
        // Remove peer dependency decorations e.g. 4.19.2_debug@4.3.4
        const cleanVersion = rawVersion.split("_")[0].trim();

        const isDirect = directDepNames.has(name);
        const isTransitive = !isDirect;
        const key = `${name}@${cleanVersion}`;

        if (!depsMap.has(key)) {
          depsMap.set(key, {
            name,
            version: cleanVersion,
            manifestFile: filePath,
            ecosystem: "npm",
            isTransitive,
          });
        } else if (depsMap.get(key)!.isTransitive && isDirect) {
          depsMap.get(key)!.isTransitive = false;
        }
      }
    }
  }

  return Array.from(depsMap.values());
}
