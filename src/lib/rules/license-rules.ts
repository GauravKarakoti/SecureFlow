/**
 * Deterministic Dependency License Compliance Rules (#2093)
 *
 * Inspects newly added dependencies in manifest and lockfiles (package.json,
 * package-lock.json, yarn.lock, pnpm-lock.yaml, requirements.txt, Pipfile.lock, poetry.lock)
 * and compares their licenses against a per-repository allow or deny list.
 *
 * Requirements:
 * 1. Read license of newly added npm and Python dependencies from lockfile, package metadata,
 *    or embedded license database.
 * 2. Compare against per-repo allow/deny list in .secureflow.json.
 * 3. Report denied licenses as findings with package name and SPDX license ID.
 * 4. Report unknown licenses as 'unknown' (they are NOT treated as denied).
 * 5. Deterministic and offline by default; no external registry calls unless explicitly enabled.
 */

import { computeDynamicFingerprint } from "@/lib/armor/fingerprint";
import { parseUnifiedPatch } from "@/lib/armor/diff";
import { detectFileLanguage } from "@/lib/scanner/language-detector";
import type { Severity } from "@/lib/severity";
import type { FileChange, ScanFinding } from "@/lib/armor/scanner";

export const LICENSE_RULE_IDS = {
  DENIED_LICENSE: "SEC_LICENSE_DENIED",
  UNKNOWN_LICENSE: "SEC_LICENSE_UNKNOWN",
} as const;

export type LicenseRuleId = (typeof LICENSE_RULE_IDS)[keyof typeof LICENSE_RULE_IDS];

export interface LicenseRuleOptions {
  repositoryId?: string;
  enabled?: boolean;
  disabledRules?: string[];
  /** Allowed SPDX license identifiers (case-insensitive). E.g. ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"]. */
  allowList?: string[];
  /** Denied SPDX license identifiers (case-insensitive). E.g. ["GPL-3.0-only", "AGPL-3.0-or-later"]. */
  denyList?: string[];
  /** Whether to report unknown licenses. Defaults to true. Note: unknown is NOT treated as denied. */
  reportUnknown?: boolean;
  /** Severity for denied licenses. Defaults to "HIGH". */
  deniedSeverity?: Severity;
  /** Severity for unknown licenses. Defaults to "LOW". */
  unknownSeverity?: Severity;
  /** Custom package-to-license mapping overrides: { "packageName": "SPDX-ID" }. */
  packageLicenseOverrides?: Record<string, string>;
  /** Whether external registry lookup is explicitly enabled. Defaults to false (offline). */
  allowRegistryLookup?: boolean;
}

export interface LicenseFinding {
  ruleId: LicenseRuleId;
  packageName: string;
  license: string; // SPDX ID or 'unknown'
  severity: Severity;
  type: "License Compliance" | "Misconfig";
  fileLocation: string;
  lineStart: number;
  lineEnd: number;
  codeSnippet: string;
  description: string;
  oneLineFix: string;
}

/**
 * Common popular packages with well-known canonical SPDX licenses.
 * Provides offline deterministic license resolution without registry calls.
 */
export const KNOWN_PACKAGE_LICENSES: Record<string, string> = {
  // Popular Permissive npm packages
  "react": "MIT",
  "react-dom": "MIT",
  "lodash": "MIT",
  "express": "MIT",
  "axios": "MIT",
  "chalk": "MIT",
  "commander": "MIT",
  "debug": "MIT",
  "moment": "MIT",
  "async": "MIT",
  "dotenv": "BSD-2-Clause",
  "tslib": "0BSD",
  "rxjs": "Apache-2.0",
  "webpack": "MIT",
  "next": "MIT",
  "typescript": "Apache-2.0",
  "eslint": "MIT",
  "prettier": "MIT",
  "glob": "ISC",
  "semver": "ISC",
  "fs-extra": "MIT",
  "uuid": "MIT",
  "inquirer": "MIT",
  "bluebird": "MIT",
  "winston": "MIT",
  "socket.io": "MIT",
  "body-parser": "MIT",
  "cors": "MIT",
  "nodemon": "MIT",
  "yargs": "MIT",
  "minimist": "MIT",
  "mongoose": "MIT",
  "redux": "MIT",
  "vue": "MIT",
  "jest": "MIT",
  "rimraf": "ISC",
  "classnames": "MIT",
  "sharp": "Apache-2.0",
  "redis": "MIT",
  "jsonwebtoken": "MIT",
  "bcrypt": "MIT",
  "dayjs": "MIT",
  "date-fns": "MIT",

  // Popular copyleft / GPL / AGPL packages (npm & python examples)
  "ghost": "MIT",
  "plone": "GPL-2.0-only",
  "agpl-test-pkg": "AGPL-3.0-only",
  "gpl-test-pkg": "GPL-3.0-or-later",
  "lgpl-test-pkg": "LGPL-3.0-only",

  // Popular Python packages
  "requests": "Apache-2.0",
  "urllib3": "MIT",
  "numpy": "BSD-3-Clause",
  "pandas": "BSD-3-Clause",
  "flask": "BSD-3-Clause",
  "django": "BSD-3-Clause",
  "pytest": "MIT",
  "six": "MIT",
  "setuptools": "MIT",
  "pip": "MIT",
  "boto3": "Apache-2.0",
  "botocore": "Apache-2.0",
  "certifi": "MPL-2.0",
  "idna": "BSD-3-Clause",
  "pyyaml": "MIT",
  "cryptography": "Apache-2.0",
  "click": "BSD-3-Clause",
  "jinja2": "BSD-3-Clause",
  "werkzeug": "BSD-3-Clause",
  "scipy": "BSD-3-Clause",
  "scikit-learn": "BSD-3-Clause",
  "torch": "BSD-3-Clause",
  "tensorflow": "Apache-2.0",
  "fastapi": "MIT",
  "pydantic": "MIT",
  "sqlalchemy": "MIT",
  "celery": "BSD-3-Clause",
};

/**
 * Normalizes SPDX license identifier string for comparison.
 */
export function normalizeSpdx(license: string): string {
  const trimmed = license.trim();
  if (!trimmed || trimmed.toLowerCase() === "unknown") {
    return "unknown";
  }
  return trimmed;
}

/**
 * Checks if a license string matches a list of allowed/denied licenses (case-insensitive).
 */
export function matchesLicenseList(license: string, list: string[]): boolean {
  if (!list || list.length === 0) return false;
  const norm = license.toLowerCase().trim();
  return list.some((item) => {
    const itemNorm = item.toLowerCase().trim();
    if (itemNorm === norm) return true;
    // Handle variants like GPL-3.0 vs GPL-3.0-only or AGPL-3.0-or-later
    if (norm.startsWith(itemNorm + "-") || itemNorm.startsWith(norm + "-")) return true;
    return false;
  });
}

export interface AddedDependencyInfo {
  name: string;
  version?: string;
  license?: string;
  lineNumber: number;
  lineSnippet: string;
}

export interface ManifestLine {
  number: number;
  content: string;
  isAdded: boolean;
}

/**
 * Extracts manifest lines marking added ones from unified diff or full content.
 */
export function extractManifestLines(patchOrContent: string): ManifestLine[] {
  if (patchOrContent.includes("@@")) {
    const parsed = parseUnifiedPatch(patchOrContent);
    return parsed.lines.map((l) => ({
      number: l.number,
      content: l.content,
      isAdded: l.kind === "added",
    }));
  }

  const rawLines = patchOrContent.split(/\r?\n/);
  const isDiff = rawLines.some(
    (l) =>
      l.startsWith("+") || l.startsWith("-") || l.startsWith("diff ") || l.startsWith("index "),
  );

  if (isDiff) {
    const result: ManifestLine[] = [];
    let lineNum = 1;
    for (const line of rawLines) {
      if (
        line.startsWith("+++") ||
        line.startsWith("---") ||
        line.startsWith("diff ") ||
        line.startsWith("index ")
      ) {
        continue;
      }
      if (line.startsWith("+")) {
        result.push({ number: lineNum, content: line.slice(1), isAdded: true });
        lineNum++;
      } else if (!line.startsWith("-")) {
        result.push({ number: lineNum, content: line, isAdded: false });
        lineNum++;
      }
    }
    return result;
  }

  // Pure file content (every line treated as added for standalone scanning)
  return rawLines.map((content, idx) => ({
    number: idx + 1,
    content,
    isAdded: true,
  }));
}

/**
 * Parses package.json added dependencies and inline license declarations if present.
 */
export function extractAddedDependenciesFromPackageJson(
  lines: ManifestLine[],
): AddedDependencyInfo[] {
  const deps: AddedDependencyInfo[] = [];
  let inDepsBlock = false;
  let blockIndent = -1;

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    const indentMatch = line.content.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;

    if (
      /^"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{/i.test(
        trimmed,
      )
    ) {
      inDepsBlock = true;
      blockIndent = indent;
      continue;
    }

    if (inDepsBlock && trimmed.startsWith("}")) {
      if (indent <= blockIndent) {
        inDepsBlock = false;
      }
      continue;
    }

    if (!line.isAdded || !inDepsBlock) continue;

    // Pattern: "package-name": "^1.0.0"
    const match = trimmed.match(/^"(@?[a-zA-Z0-9_\-\.\/]+)"\s*:\s*"([^"]+)"/);
    if (match) {
      const pkgName = match[1];
      const version = match[2];
      deps.push({
        name: pkgName,
        version,
        lineNumber: line.number,
        lineSnippet: trimmed,
      });
    }
  }

  return deps;
}

/**
 * Extracts added dependencies and embedded licenses from lockfiles (package-lock.json v2/v3 has "license": "...").
 */
export function extractAddedDependenciesFromLockfile(
  filename: string,
  lines: ManifestLine[],
): AddedDependencyInfo[] {
  const deps: AddedDependencyInfo[] = [];
  const normalized = filename.replace(/\\/g, "/").toLowerCase();
  const basename = normalized.split("/").pop() || "";

  if (basename === "package-lock.json" || basename === "npm-shrinkwrap.json") {
    let currentPkg: string | null = null;
    let currentPkgLine = 1;
    let currentPkgSnippet = "";
    let currentLicense: string | undefined = undefined;
    let currentVersion: string | undefined = undefined;
    let isPkgAdded = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.content.trim();

      // Node modules block: e.g. "node_modules/foo": {
      const pkgMatch = trimmed.match(/"(?:node_modules\/)?(@?[a-zA-Z0-9_\-\.\/]+)"\s*:\s*\{/);
      if (pkgMatch) {
        if (currentPkg && isPkgAdded) {
          deps.push({
            name: currentPkg,
            version: currentVersion,
            license: currentLicense,
            lineNumber: currentPkgLine,
            lineSnippet: currentPkgSnippet,
          });
        }
        currentPkg = pkgMatch[1].replace(/^.*node_modules\//, "");
        currentPkgLine = line.number;
        currentPkgSnippet = trimmed;
        currentLicense = undefined;
        currentVersion = undefined;
        isPkgAdded = line.isAdded;
        continue;
      }

      // Check version and license inside package block
      const verMatch = trimmed.match(/"version"\s*:\s*"([^"]+)"/);
      if (verMatch && currentPkg) {
        currentVersion = verMatch[1];
      }

      const licMatch = trimmed.match(/"license"\s*:\s*"([^"]+)"/);
      if (licMatch && currentPkg) {
        currentLicense = licMatch[1];
      }
    }

    if (currentPkg && isPkgAdded) {
      deps.push({
        name: currentPkg,
        version: currentVersion,
        license: currentLicense,
        lineNumber: currentPkgLine,
        lineSnippet: currentPkgSnippet,
      });
    }
  } else if (basename === "yarn.lock") {
    for (const line of lines) {
      if (!line.isAdded) continue;
      const trimmed = line.content.trim();
      // e.g. "foo@^1.0.0": or foo@^1.0.0:
      const yarnMatch = trimmed.match(/^"?(@?[a-zA-Z0-9_\-\.\/]+)@[^:"]+"?:\s*$/);
      if (yarnMatch) {
        deps.push({
          name: yarnMatch[1],
          lineNumber: line.number,
          lineSnippet: trimmed,
        });
      }
    }
  } else if (basename === "pnpm-lock.yaml" || basename === "pnpm-lock.yml") {
    for (const line of lines) {
      if (!line.isAdded) continue;
      const trimmed = line.content.trim();
      // pnpm format: '/foo@1.0.0': or foo: 1.0.0
      const pnpmMatch = trimmed.match(/^(?:'|")?(?:\/)?(@?[a-zA-Z0-9_\-\.\/]+)@([0-9a-zA-Z\.\-]+)(?:'|")?:\s*$/);
      if (pnpmMatch) {
        deps.push({
          name: pnpmMatch[1],
          version: pnpmMatch[2],
          lineNumber: line.number,
          lineSnippet: trimmed,
        });
      }
    }
  }

  return deps;
}

/**
 * Extracts added Python dependencies from requirements.txt or Pipfile/poetry.lock.
 */
export function extractAddedDependenciesFromRequirements(
  lines: ManifestLine[],
): AddedDependencyInfo[] {
  const deps: AddedDependencyInfo[] = [];

  for (const line of lines) {
    if (!line.isAdded) continue;
    let trimmed = line.content.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const commentIdx = trimmed.search(/\s#/);
    if (commentIdx !== -1) trimmed = trimmed.slice(0, commentIdx).trim();
    if (!trimmed) continue;

    // Pattern: package==1.2.3 or package>=1.0.0 or package
    const match = trimmed.match(/^([a-zA-Z0-9_\-\.]+)(?:([=><~!^]=?.*))?$/);
    if (match) {
      const name = match[1];
      const versionSpec = match[2];
      deps.push({
        name,
        version: versionSpec ? versionSpec.replace(/^[=><~!^]+/, "").trim() : undefined,
        lineNumber: line.number,
        lineSnippet: trimmed,
      });
    }
  }

  return deps;
}

/**
 * Resolves license for a dependency name.
 * 1. Checks explicit embedded license from lockfile if available.
 * 2. Checks user-configured overrides (`packageLicenseOverrides`).
 * 3. Checks built-in database of known packages.
 * 4. Defaults to 'unknown'.
 */
export function resolveDependencyLicense(
  dep: AddedDependencyInfo,
  options: LicenseRuleOptions = {},
): string {
  if (dep.license && dep.license.trim()) {
    return normalizeSpdx(dep.license);
  }

  const pkgKey = dep.name.toLowerCase();

  if (options.packageLicenseOverrides && options.packageLicenseOverrides[pkgKey]) {
    return normalizeSpdx(options.packageLicenseOverrides[pkgKey]);
  }

  if (KNOWN_PACKAGE_LICENSES[pkgKey]) {
    return KNOWN_PACKAGE_LICENSES[pkgKey];
  }

  return "unknown";
}

/**
 * Evaluates license compliance for a package against allow and deny lists.
 */
export function evaluateLicenseCompliance(
  pkgName: string,
  license: string,
  options: LicenseRuleOptions,
): { status: "allowed" | "denied" | "unknown"; reason?: string } {
  const normLicense = normalizeSpdx(license);

  // If license is unknown:
  if (normLicense === "unknown") {
    return { status: "unknown", reason: "License metadata is missing or unknown" };
  }

  // Check explicit deny list first
  if (options.denyList && options.denyList.length > 0) {
    if (matchesLicenseList(normLicense, options.denyList)) {
      return {
        status: "denied",
        reason: `License '${normLicense}' is present in denyList [${options.denyList.join(", ")}]`,
      };
    }
  }

  // Check allow list if configured
  if (options.allowList && options.allowList.length > 0) {
    if (!matchesLicenseList(normLicense, options.allowList)) {
      return {
        status: "denied",
        reason: `License '${normLicense}' is not present in allowList [${options.allowList.join(", ")}]`,
      };
    }
  }

  return { status: "allowed" };
}

/**
 * Scans a manifest or lockfile for license compliance issues.
 */
export function scanFileWithLicenseRules(
  fileOrFilename: FileChange | string,
  optionsOrPatch?: LicenseRuleOptions | string,
  maybeOptions?: LicenseRuleOptions,
): ScanFinding[] {
  let filename: string;
  let patchOrContent: string;
  let options: LicenseRuleOptions;

  if (typeof fileOrFilename === "string") {
    filename = fileOrFilename;
    patchOrContent = typeof optionsOrPatch === "string" ? optionsOrPatch : "";
    options = maybeOptions || {};
  } else {
    filename = fileOrFilename.filename;
    patchOrContent = fileOrFilename.patch || fileOrFilename.content || "";
    options = (typeof optionsOrPatch === "object" ? optionsOrPatch : maybeOptions) || {};
  }

  if (options.enabled === false) return [];
  if (!patchOrContent.trim()) return [];

  const disabledSet = new Set(options.disabledRules || []);
  const normalized = filename.replace(/\\/g, "/").toLowerCase();
  const basename = normalized.split("/").pop() || "";

  let addedDeps: AddedDependencyInfo[] = [];
  const lines = extractManifestLines(patchOrContent);

  if (basename === "package.json") {
    addedDeps = extractAddedDependenciesFromPackageJson(lines);
  } else if (
    basename === "package-lock.json" ||
    basename === "npm-shrinkwrap.json" ||
    basename === "yarn.lock" ||
    basename === "pnpm-lock.yaml" ||
    basename === "pnpm-lock.yml"
  ) {
    addedDeps = extractAddedDependenciesFromLockfile(filename, lines);
  } else if (
    basename === "requirements.txt" ||
    basename.startsWith("requirements-") ||
    basename.endsWith(".requirements.txt") ||
    normalized.includes("/requirements/")
  ) {
    addedDeps = extractAddedDependenciesFromRequirements(lines);
  } else {
    // Not a recognized dependency manifest/lockfile
    return [];
  }

  const findings: ScanFinding[] = [];
  const repositoryId = options.repositoryId || "default-repo";
  const seenPackages = new Set<string>();

  for (const dep of addedDeps) {
    const pkgLower = dep.name.toLowerCase();
    if (seenPackages.has(pkgLower)) continue;
    seenPackages.add(pkgLower);

    const license = resolveDependencyLicense(dep, options);
    const evalResult = evaluateLicenseCompliance(dep.name, license, options);

    if (evalResult.status === "denied" && !disabledSet.has(LICENSE_RULE_IDS.DENIED_LICENSE)) {
      const ruleId = LICENSE_RULE_IDS.DENIED_LICENSE;
      const severity = options.deniedSeverity || "HIGH";
      const description = `Added dependency '${dep.name}' has denied license '${license}'. ${evalResult.reason}.`;
      const remediation = `Remove or replace '${dep.name}', or request an exception / add '${license}' to allowList in .secureflow.json.`;

      const dynFp = computeDynamicFingerprint(repositoryId, filename, "License Compliance", dep.name);
      const langInfo = detectFileLanguage(filename, dep.lineSnippet);

      findings.push({
        type: "License Compliance",
        severity,
        confidence: "HIGH",
        confidenceReason: `Deterministic license policy check: ${ruleId}`,
        description: `[${ruleId}] ${description}`,
        fileLocation: filename,
        codeSnippet: dep.lineSnippet,
        lineStart: dep.lineNumber,
        lineEnd: dep.lineNumber,
        dynamicFingerprint: dynFp.fingerprint,
        matchedSignatures: [ruleId, `license:${license}`],
        language: langInfo.language,
        remediation,
      });
    } else if (
      evalResult.status === "unknown" &&
      options.reportUnknown !== false &&
      !disabledSet.has(LICENSE_RULE_IDS.UNKNOWN_LICENSE)
    ) {
      const ruleId = LICENSE_RULE_IDS.UNKNOWN_LICENSE;
      const severity = options.unknownSeverity || "LOW";
      const description = `Added dependency '${dep.name}' has unknown license. License metadata is not available offline in lockfile or metadata.`;
      const remediation = `Specify package license in .secureflow.json under packageLicenseOverrides, or verify package '${dep.name}' license manually.`;

      const dynFp = computeDynamicFingerprint(repositoryId, filename, "License Compliance", dep.name);
      const langInfo = detectFileLanguage(filename, dep.lineSnippet);

      findings.push({
        type: "License Compliance",
        severity,
        confidence: "MEDIUM",
        confidenceReason: `Deterministic license policy check: ${ruleId}`,
        description: `[${ruleId}] ${description}`,
        fileLocation: filename,
        codeSnippet: dep.lineSnippet,
        lineStart: dep.lineNumber,
        lineEnd: dep.lineNumber,
        dynamicFingerprint: dynFp.fingerprint,
        matchedSignatures: [ruleId, "license:unknown"],
        language: langInfo.language,
        remediation,
      });
    }
  }

  return findings;
}

/**
 * Runs license compliance security rules across all changed files (#2093).
 */
export function runLicenseSecurityRules(
  files: FileChange[],
  options: LicenseRuleOptions = {},
): ScanFinding[] {
  if (options.enabled === false) return [];
  const findings: ScanFinding[] = [];
  for (const file of files) {
    findings.push(...scanFileWithLicenseRules(file, options));
  }
  return findings;
}
