/**
 * Deterministic Dependency Security Checks (#2003)
 *
 * Inspects diffs of package manifests (package.json, lockfiles, requirements.txt) for:
 *  1. Typosquatted packages (within small edit distance of popular packages).
 *  2. Dependencies added from git URLs or tarball archives.
 *  3. Newly introduced preinstall/postinstall/install lifecycle scripts.
 *
 * Operates offline by default using bundled popular package registries.
 * External registry lookups are optional and strictly rate limited.
 */

import { computeDynamicFingerprint } from "@/lib/armor/fingerprint";
import { parseUnifiedPatch } from "@/lib/armor/diff";
import { detectFileLanguage } from "@/lib/scanner/language-detector";
import type { Severity } from "@/lib/severity";
import type { FileChange, ScanFinding } from "@/lib/armor/scanner";

export const DEPENDENCY_RULE_IDS = {
  TYPOSQUAT: "DEPENDENCY_TYPOSQUAT",
  GIT_OR_TARBALL: "DEPENDENCY_GIT_OR_TARBALL",
  LIFECYCLE_SCRIPT: "DEPENDENCY_LIFECYCLE_SCRIPT",
} as const;

export interface DependencyRuleDefinition {
  id: string;
  name: string;
  severity: Severity;
  type: "Vulnerability" | "Misconfig";
  description: string;
  oneLineFix: string;
}

export const DEPENDENCY_RULES: Record<string, DependencyRuleDefinition> = {
  [DEPENDENCY_RULE_IDS.TYPOSQUAT]: {
    id: DEPENDENCY_RULE_IDS.TYPOSQUAT,
    name: "Potential typosquatted dependency",
    severity: "HIGH",
    type: "Vulnerability",
    description:
      "Package name is dangerously similar to a popular package and may be a typosquatting supply-chain attack.",
    oneLineFix:
      "Verify the exact package name against official documentation and remove or correct any mistyped dependencies.",
  },
  [DEPENDENCY_RULE_IDS.GIT_OR_TARBALL]: {
    id: DEPENDENCY_RULE_IDS.GIT_OR_TARBALL,
    name: "Git or tarball dependency source",
    severity: "HIGH",
    type: "Misconfig",
    description:
      "Dependency references a git repository or raw tarball instead of a trusted registry release.",
    oneLineFix:
      "Use official package versions from a trusted package registry instead of unverified git URLs or tarballs.",
  },
  [DEPENDENCY_RULE_IDS.LIFECYCLE_SCRIPT]: {
    id: DEPENDENCY_RULE_IDS.LIFECYCLE_SCRIPT,
    name: "Automatic install lifecycle script",
    severity: "HIGH",
    type: "Vulnerability",
    description:
      "Manifest defines an install lifecycle script (preinstall/postinstall/install) that automatically executes shell code upon installation.",
    oneLineFix:
      "Avoid install-time shell scripts; move setup logic to explicit build or test scripts.",
  },
};

/**
 * Top popular npm packages used as baseline for typosquatting detection.
 */
export const POPULAR_NPM_PACKAGES = new Set([
  "react",
  "react-dom",
  "express",
  "lodash",
  "axios",
  "chalk",
  "commander",
  "debug",
  "moment",
  "async",
  "dotenv",
  "tslib",
  "rxjs",
  "webpack",
  "next",
  "typescript",
  "cross-env",
  "eslint",
  "prettier",
  "glob",
  "semver",
  "fs-extra",
  "uuid",
  "inquirer",
  "bluebird",
  "winston",
  "socket.io",
  "body-parser",
  "cors",
  "nodemon",
  "superagent",
  "yargs",
  "minimist",
  "request",
  "mongoose",
  "redux",
  "vue",
  "jest",
  "babel-core",
  "core-js",
  "cheerio",
  "postcss",
  "rimraf",
  "classnames",
  "cookie-parser",
  "morgan",
  "sharp",
  "passport",
  "validator",
  "redis",
  "jsonwebtoken",
  "bcrypt",
  "multer",
  "colors",
  "commander",
  "got",
  "node-fetch",
  "dayjs",
  "date-fns",
]);

/**
 * Top popular PyPI packages used as baseline for typosquatting detection.
 */
export const POPULAR_PYPI_PACKAGES = new Set([
  "requests",
  "urllib3",
  "numpy",
  "pandas",
  "flask",
  "django",
  "pytest",
  "six",
  "setuptools",
  "pip",
  "boto3",
  "botocore",
  "certifi",
  "idna",
  "pyyaml",
  "scipy",
  "cryptography",
  "colorama",
  "click",
  "jinja2",
  "wheel",
  "scikit-learn",
  "matplotlib",
  "pydantic",
  "typing-extensions",
  "attrs",
  "virtualenv",
  "pillow",
  "charset-normalizer",
  "rsa",
  "werkzeug",
  "sqlalchemy",
  "celery",
  "fastapi",
  "uvicorn",
  "redis",
  "torch",
  "transformers",
  "psycopg2",
  "black",
  "flake8",
  "aiohttp",
  "httpx",
  "beautifulsoup4",
  "tqdm",
]);

export interface DependencyRuleFinding {
  ruleId: string;
  ruleName: string;
  severity: Severity;
  type: "Vulnerability" | "Misconfig";
  fileLocation: string;
  lineStart: number;
  lineEnd: number;
  codeSnippet: string;
  description: string;
  oneLineFix: string;
  packageName?: string;
}

export interface DependencyRuleOptions {
  repositoryId?: string;
  enableRegistryLookup?: boolean;
  registryRateLimiter?: {
    consume: () => Promise<boolean>;
  };
}

export interface ManifestLine {
  number: number;
  content: string;
  isAdded: boolean;
}

/**
 * Checks whether the given file is a recognized dependency manifest or lockfile.
 */
export function isDependencyManifest(filename: string): boolean {
  if (!filename) return false;
  const normalized = filename.replace(/\\/g, "/").toLowerCase();
  const basename = normalized.split("/").pop() || "";

  if (
    basename === "package.json" ||
    basename === "package-lock.json" ||
    basename === "npm-shrinkwrap.json" ||
    basename === "yarn.lock" ||
    basename === "pnpm-lock.yaml"
  ) {
    return true;
  }

  if (
    basename === "requirements.txt" ||
    basename.startsWith("requirements-") ||
    basename.endsWith(".requirements.txt") ||
    normalized.startsWith("requirements/") ||
    normalized.includes("/requirements/")
  ) {
    return true;
  }

  return false;
}

/**
 * Computes Damerau-Levenshtein distance (including adjacent transpositions).
 */
export function damerauLevenshteinDistance(source: string, target: string): number {
  const m = source.length;
  const n = target.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = source[i - 1] === target[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost, // substitution
      );

      // Transposition
      if (i > 1 && j > 1 && source[i - 1] === target[j - 2] && source[i - 2] === target[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }

  return d[m][n];
}

/**
 * Evaluates whether a package name is a potential typosquat of popular packages.
 * Legitimate packages (exact match distance 0) return { isTyposquat: false }.
 */
export function detectTyposquat(
  candidate: string,
  popularPackages: Set<string>,
): { isTyposquat: boolean; target?: string; distance?: number } {
  if (!candidate) return { isTyposquat: false };

  // Strip scope (e.g. @types/lodash -> lodash) if present for comparison
  let cleanName = candidate.toLowerCase().trim();
  if (cleanName.startsWith("@")) {
    const parts = cleanName.split("/");
    if (parts.length > 1) {
      cleanName = parts[1];
    }
  }

  // Exact match is legitimate — NEVER flag exact matches
  if (popularPackages.has(cleanName)) {
    return { isTyposquat: false };
  }

  for (const popular of popularPackages) {
    // Quick length prune
    if (Math.abs(cleanName.length - popular.length) > 2) {
      continue;
    }

    const dist = damerauLevenshteinDistance(cleanName, popular);

    if (dist === 0) {
      return { isTyposquat: false };
    }

    // Distance 1 is always flagged.
    // Distance 2 flagged for names of length >= 6 (avoids overly broad false positives on tiny names)
    if (dist === 1 || (dist === 2 && popular.length >= 6)) {
      return { isTyposquat: true, target: popular, distance: dist };
    }
  }

  return { isTyposquat: false };
}

/**
 * Checks whether a dependency specifier is a git URL or tarball.
 */
export function isGitOrTarballSpecifier(specifier: string): boolean {
  if (!specifier) return false;
  const trimmed = specifier.trim();

  // Git protocols or GitHub shortcuts
  if (/^(?:git(?:\+[a-z]+)?|github|ssh):/i.test(trimmed)) {
    return true;
  }
  if (/^git@[a-zA-Z0-9_\-\.]+:/i.test(trimmed)) {
    return true;
  }
  if (/^https?:\/\/github\.com\/[^\/]+\/[^\/]+\/(?:tarball|archive)\//i.test(trimmed)) {
    return true;
  }

  // Raw tarballs, archives, or wheels
  if (/\.(?:tar\.gz|tgz|tar|zip|whl)(?:$|[?#])/i.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Extracts manifest lines from patch or full content.
 * Flags which lines are newly added in a pull request diff.
 */
export function extractManifestLines(patchOrContent: string): ManifestLine[] {
  if (!patchOrContent) return [];

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
 * Scans package.json changes for typosquats, git/tarballs, and lifecycle scripts.
 */
export function scanPackageJson(filename: string, lines: ManifestLine[]): DependencyRuleFinding[] {
  const findings: DependencyRuleFinding[] = [];
  const typosquatDef = DEPENDENCY_RULES[DEPENDENCY_RULE_IDS.TYPOSQUAT];
  const gitTarballDef = DEPENDENCY_RULES[DEPENDENCY_RULE_IDS.GIT_OR_TARBALL];
  const lifecycleDef = DEPENDENCY_RULES[DEPENDENCY_RULE_IDS.LIFECYCLE_SCRIPT];

  let inScriptsBlock = false;
  let inDepsBlock = false;
  let blockIndent = -1;

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    const indentMatch = line.content.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;

    // Detect section transitions
    if (
      /^"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{/i.test(
        trimmed,
      )
    ) {
      inDepsBlock = true;
      inScriptsBlock = false;
      blockIndent = indent;
      continue;
    }

    if (/^"scripts"\s*:\s*\{/i.test(trimmed)) {
      inScriptsBlock = true;
      inDepsBlock = false;
      blockIndent = indent;
      continue;
    }

    if ((inDepsBlock || inScriptsBlock) && trimmed.startsWith("}")) {
      if (indent <= blockIndent) {
        inDepsBlock = false;
        inScriptsBlock = false;
      }
      continue;
    }

    // Only inspect lines that were newly added in this diff
    if (!line.isAdded) continue;

    // 1. Check for lifecycle scripts in scripts block or general scripts declaration
    if (
      inScriptsBlock ||
      trimmed.includes('"preinstall"') ||
      trimmed.includes('"postinstall"') ||
      trimmed.includes('"install"')
    ) {
      const scriptMatch = trimmed.match(
        /^"(preinstall|postinstall|install|preuninstall|postuninstall)"\s*:\s*("[^"]*")/i,
      );
      if (scriptMatch) {
        const scriptName = scriptMatch[1];
        findings.push({
          ruleId: lifecycleDef.id,
          ruleName: lifecycleDef.name,
          severity: lifecycleDef.severity,
          type: lifecycleDef.type,
          fileLocation: filename,
          lineStart: line.number,
          lineEnd: line.number,
          codeSnippet: trimmed,
          description: `Manifest adds high-risk '${scriptName}' install script which executes code automatically on install.`,
          oneLineFix: lifecycleDef.oneLineFix,
          packageName: scriptName,
        });
      }
    }

    // 2. Check for dependencies (typosquats, git URLs, tarballs)
    const depMatch = trimmed.match(/^"(@?[a-zA-Z0-9_\-\.\/]+)"\s*:\s*"([^"]+)"/);
    if (depMatch) {
      const pkgName = depMatch[1];
      const specifier = depMatch[2];

      // A. Git URL or Tarball dependency
      if (isGitOrTarballSpecifier(specifier)) {
        findings.push({
          ruleId: gitTarballDef.id,
          ruleName: gitTarballDef.name,
          severity: gitTarballDef.severity,
          type: gitTarballDef.type,
          fileLocation: filename,
          lineStart: line.number,
          lineEnd: line.number,
          codeSnippet: trimmed,
          description: `Dependency '${pkgName}' added from unverified source (${specifier}).`,
          oneLineFix: gitTarballDef.oneLineFix,
          packageName: pkgName,
        });
      }

      // B. Typosquatted package name
      const typoCheck = detectTyposquat(pkgName, POPULAR_NPM_PACKAGES);
      if (typoCheck.isTyposquat && typoCheck.target) {
        findings.push({
          ruleId: typosquatDef.id,
          ruleName: typosquatDef.name,
          severity: typosquatDef.severity,
          type: typosquatDef.type,
          fileLocation: filename,
          lineStart: line.number,
          lineEnd: line.number,
          codeSnippet: trimmed,
          description: `Added dependency '${pkgName}' is dangerously similar to popular package '${typoCheck.target}' (distance: ${typoCheck.distance}).`,
          oneLineFix: `Verify package identity; if intending to use '${typoCheck.target}', correct the spelling in package.json.`,
          packageName: pkgName,
        });
      }
    }
  }

  return findings;
}

/**
 * Scans npm lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml) for risky dependencies.
 */
export function scanLockfile(filename: string, lines: ManifestLine[]): DependencyRuleFinding[] {
  const findings: DependencyRuleFinding[] = [];
  const typosquatDef = DEPENDENCY_RULES[DEPENDENCY_RULE_IDS.TYPOSQUAT];
  const gitTarballDef = DEPENDENCY_RULES[DEPENDENCY_RULE_IDS.GIT_OR_TARBALL];

  for (const line of lines) {
    if (!line.isAdded) continue;
    const trimmed = line.content.trim();
    if (!trimmed) continue;

    // Package-lock.json / shrinkwrap
    // e.g. "node_modules/lodashs": { or "resolved": "https://evil.com/payload.tgz"
    const lockPackageMatch = trimmed.match(/"(?:node_modules\/)?(@?[a-zA-Z0-9_\-\.\/]+)"\s*:\s*\{/);
    if (lockPackageMatch) {
      const rawName = lockPackageMatch[1];
      const pkgName = rawName.replace(/^.*node_modules\//, "");
      const typoCheck = detectTyposquat(pkgName, POPULAR_NPM_PACKAGES);
      if (typoCheck.isTyposquat && typoCheck.target) {
        findings.push({
          ruleId: typosquatDef.id,
          ruleName: typosquatDef.name,
          severity: typosquatDef.severity,
          type: typosquatDef.type,
          fileLocation: filename,
          lineStart: line.number,
          lineEnd: line.number,
          codeSnippet: trimmed,
          description: `Lockfile adds potential typosquatted package '${pkgName}' targeting '${typoCheck.target}'.`,
          oneLineFix: typosquatDef.oneLineFix,
          packageName: pkgName,
        });
      }
    }

    const resolvedMatch = trimmed.match(
      /"resolved"\s*:\s*"([^"]+)"|resolved\s+"([^"]+)"|tarball:\s*([^\s]+)/i,
    );
    if (resolvedMatch) {
      const resolvedUrl = resolvedMatch[1] || resolvedMatch[2] || resolvedMatch[3];
      // Only flag if resolved to an untrusted external tarball or git URL (not standard registry.npmjs.org)
      if (
        isGitOrTarballSpecifier(resolvedUrl) &&
        !resolvedUrl.includes("registry.npmjs.org") &&
        !resolvedUrl.includes("registry.yarnpkg.com")
      ) {
        findings.push({
          ruleId: gitTarballDef.id,
          ruleName: gitTarballDef.name,
          severity: gitTarballDef.severity,
          type: gitTarballDef.type,
          fileLocation: filename,
          lineStart: line.number,
          lineEnd: line.number,
          codeSnippet: trimmed,
          description: `Lockfile resolves dependency from untrusted source (${resolvedUrl}).`,
          oneLineFix: gitTarballDef.oneLineFix,
        });
      }
    }

    // Yarn lock header: e.g. "lodashs@^4.17.21": or lodashs@^4.17.21:
    const yarnMatch = trimmed.match(/^"?(@?[a-zA-Z0-9_\-\.\/]+)@[^:"]+"?:\s*$/);
    if (yarnMatch) {
      const pkgName = yarnMatch[1];
      const typoCheck = detectTyposquat(pkgName, POPULAR_NPM_PACKAGES);
      if (typoCheck.isTyposquat && typoCheck.target) {
        findings.push({
          ruleId: typosquatDef.id,
          ruleName: typosquatDef.name,
          severity: typosquatDef.severity,
          type: typosquatDef.type,
          fileLocation: filename,
          lineStart: line.number,
          lineEnd: line.number,
          codeSnippet: trimmed,
          description: `Yarn lockfile adds potential typosquatted package '${pkgName}' targeting '${typoCheck.target}'.`,
          oneLineFix: typosquatDef.oneLineFix,
          packageName: pkgName,
        });
      }
    }
  }

  return findings;
}

/**
 * Scans Python requirements.txt for typosquats and git/tarball URLs.
 */
export function scanRequirementsTxt(
  filename: string,
  lines: ManifestLine[],
): DependencyRuleFinding[] {
  const findings: DependencyRuleFinding[] = [];
  const typosquatDef = DEPENDENCY_RULES[DEPENDENCY_RULE_IDS.TYPOSQUAT];
  const gitTarballDef = DEPENDENCY_RULES[DEPENDENCY_RULE_IDS.GIT_OR_TARBALL];

  for (const line of lines) {
    if (!line.isAdded) continue;
    let trimmed = line.content.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Strip inline comment
    const commentAt = trimmed.search(/\s#/);
    if (commentAt !== -1) trimmed = trimmed.slice(0, commentAt).trim();
    if (!trimmed) continue;

    // 1. Direct git or tarball URL requirement (e.g. https://.../pkg.tar.gz or git+https://...)
    if (isGitOrTarballSpecifier(trimmed)) {
      findings.push({
        ruleId: gitTarballDef.id,
        ruleName: gitTarballDef.name,
        severity: gitTarballDef.severity,
        type: gitTarballDef.type,
        fileLocation: filename,
        lineStart: line.number,
        lineEnd: line.number,
        codeSnippet: trimmed,
        description: `Python requirements specify direct git or tarball dependency (${trimmed}).`,
        oneLineFix: gitTarballDef.oneLineFix,
      });
      continue;
    }

    // 2. Direct reference: pkg @ https://... or pkg @ git+https://...
    if (trimmed.includes("@")) {
      const parts = trimmed.split("@");
      const pkgName = parts[0].trim();
      const specifier = parts.slice(1).join("@").trim();

      if (isGitOrTarballSpecifier(specifier)) {
        findings.push({
          ruleId: gitTarballDef.id,
          ruleName: gitTarballDef.name,
          severity: gitTarballDef.severity,
          type: gitTarballDef.type,
          fileLocation: filename,
          lineStart: line.number,
          lineEnd: line.number,
          codeSnippet: trimmed,
          description: `Python dependency '${pkgName}' references external git or tarball source (${specifier}).`,
          oneLineFix: gitTarballDef.oneLineFix,
          packageName: pkgName,
        });
      }

      const typoCheck = detectTyposquat(pkgName, POPULAR_PYPI_PACKAGES);
      if (typoCheck.isTyposquat && typoCheck.target) {
        findings.push({
          ruleId: typosquatDef.id,
          ruleName: typosquatDef.name,
          severity: typosquatDef.severity,
          type: typosquatDef.type,
          fileLocation: filename,
          lineStart: line.number,
          lineEnd: line.number,
          codeSnippet: trimmed,
          description: `Added Python dependency '${pkgName}' is dangerously similar to popular package '${typoCheck.target}' (distance: ${typoCheck.distance}).`,
          oneLineFix: `Verify package identity; if intending to use '${typoCheck.target}', correct the spelling in requirements.txt.`,
          packageName: pkgName,
        });
      }
      continue;
    }

    // 3. Standard requirement: e.g. coloramaa==0.4.4 or reqeusts>=2.25.0
    const nameMatch = trimmed.match(
      /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:\s*\[[^\]]*\])?\s*(.*)$/,
    );
    if (nameMatch) {
      const pkgName = nameMatch[1];
      const typoCheck = detectTyposquat(pkgName, POPULAR_PYPI_PACKAGES);
      if (typoCheck.isTyposquat && typoCheck.target) {
        findings.push({
          ruleId: typosquatDef.id,
          ruleName: typosquatDef.name,
          severity: typosquatDef.severity,
          type: typosquatDef.type,
          fileLocation: filename,
          lineStart: line.number,
          lineEnd: line.number,
          codeSnippet: trimmed,
          description: `Added Python dependency '${pkgName}' is dangerously similar to popular package '${typoCheck.target}' (distance: ${typoCheck.distance}).`,
          oneLineFix: `Verify package identity; if intending to use '${typoCheck.target}', correct the spelling in requirements.txt.`,
          packageName: pkgName,
        });
      }
    }
  }

  return findings;
}

/**
 * Scans a single dependency manifest or lockfile.
 */
export function scanDependencyManifest(
  filename: string,
  patchOrContent: string,
  options: DependencyRuleOptions = {},
): ScanFinding[] {
  if (!isDependencyManifest(filename)) {
    return [];
  }

  const lines = extractManifestLines(patchOrContent);
  if (lines.length === 0) {
    return [];
  }

  const normalized = filename.replace(/\\/g, "/").toLowerCase();
  const basename = normalized.split("/").pop() || "";

  let rawFindings: DependencyRuleFinding[] = [];

  if (basename === "package.json") {
    rawFindings = scanPackageJson(filename, lines);
  } else if (
    basename === "package-lock.json" ||
    basename === "npm-shrinkwrap.json" ||
    basename === "yarn.lock" ||
    basename === "pnpm-lock.yaml"
  ) {
    rawFindings = scanLockfile(filename, lines);
  } else if (
    basename === "requirements.txt" ||
    basename.startsWith("requirements-") ||
    basename.endsWith(".requirements.txt") ||
    normalized.includes("/requirements/")
  ) {
    rawFindings = scanRequirementsTxt(filename, lines);
  }

  const repositoryId = options.repositoryId || "default-repo";

  return rawFindings.map((finding) => {
    const dynFp = computeDynamicFingerprint(
      repositoryId,
      filename,
      finding.type,
      finding.codeSnippet,
    );
    const langInfo = detectFileLanguage(filename, finding.codeSnippet);

    return {
      type: finding.type,
      severity: finding.severity,
      confidence: "HIGH",
      confidenceReason: `Deterministic dependency security rule: ${finding.ruleId}`,
      description: `[${finding.ruleId}] ${finding.description} Fix: ${finding.oneLineFix}`,
      fileLocation: filename,
      codeSnippet: finding.codeSnippet,
      lineStart: finding.lineStart,
      lineEnd: finding.lineEnd,
      dynamicFingerprint: dynFp.fingerprint,
      signatureVersion: "1.0.0",
      matchedSignatures: [finding.ruleId, "dependency-rules-deterministic"],
      isZeroDay: false,
      language: langInfo.language,
      ...(langInfo.framework ? { framework: langInfo.framework } : {}),
      remediation: finding.oneLineFix,
    };
  });
}

/**
 * Scans a list of file changes for risky dependencies.
 */
export function runDependencySecurityRules(
  files: FileChange[],
  options: DependencyRuleOptions = {},
): ScanFinding[] {
  const findings: ScanFinding[] = [];

  for (const file of files) {
    if (!isDependencyManifest(file.filename)) continue;
    if (!file.patch || !file.patch.trim()) continue;

    const fileFindings = scanDependencyManifest(file.filename, file.patch, options);
    findings.push(...fileFindings);
  }

  return findings;
}
