import { Dependency } from "@/types/sbom";
import { detectAndParseSbom } from "./sbom-format-detector";
import {
  parsePackageLockJson,
  parsePnpmLockYaml,
  parseYarnLock,
  parseCargoLock,
  parseGoSum,
} from "./lockfile-parser";
import { createLogger } from "@/lib/logger";

const log = createLogger({ context: { component: "dependency-parser" } });

/** Manifest file names `parseManifestFile` can read. Any other file yields no dependencies. */
export const SUPPORTED_MANIFESTS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "go.sum",
  "requirements.txt",
  "bom.json",
  "sbom.json",
] as const;

const SBOM_SUFFIX_PATTERNS = [".cdx.json", ".spdx.json"] as const;

export function isSupportedManifest(filePath: string): boolean {
  if (SUPPORTED_MANIFESTS.some((name) => filePath.endsWith(name))) return true;
  return SBOM_SUFFIX_PATTERNS.some((suffix) => filePath.endsWith(suffix));
}

export function isSbomManifest(filePath: string): boolean {
  if (filePath.endsWith("bom.json") || filePath.endsWith("sbom.json")) return true;
  return SBOM_SUFFIX_PATTERNS.some((suffix) => filePath.endsWith(suffix));
}

/**
 * Specifiers that name a source rather than a version: aliases, local paths,
 * workspace links and git or URL installs. None of them carries a version OSV
 * can match, so they are reported as `unknown` and skipped rather than guessed
 * at.
 */
const NON_VERSION_PROTOCOL =
  /^(?:npm|file|link|workspace|portal|github|git|git\+[a-z]+|https?|ssh):/i;

/**
 * One comparator of an npm range: an optional operator, an optional `v`, then a
 * concrete release with an optional prerelease or build tag.
 */
const COMPARATOR = /([<>=~^]*)\s*v?(\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)/g;

/**
 * Reduce an npm version specifier to a concrete version OSV can query.
 *
 * The previous rule stripped a single leading non-digit, which only ever
 * handled `^` and `~`. Everything else came out malformed — `>=1.2.3` became
 * `=1.2.3`, `latest` became `atest`, `workspace:*` became `orkspace:*` — and a
 * malformed version is not an error at OSV, it simply matches no advisory. The
 * dependency was then reported clean, which is the worst way for a scanner to
 * be wrong.
 *
 * A manifest range does not pin a version, only a lockfile does, so this takes
 * the range's lower bound — the same reading `^1.2.3` → `1.2.3` already had.
 * An exclusive upper bound is skipped: `<4.17.21` names the one version the
 * package is known *not* to be on, and the old rule dropped the operator and
 * queried it as though it were installed.
 *
 * Anything with no concrete lower bound — a wildcard, `latest`, a source
 * specifier — yields `unknown`, which `queryOsvForDependency` skips.
 */
export function normalizeNpmVersion(specifier: string): string {
  const trimmed = specifier.trim();

  if (!trimmed || NON_VERSION_PROTOCOL.test(trimmed)) return "unknown";

  for (const match of trimmed.matchAll(COMPARATOR)) {
    const [whole, operator, version] = match;

    // `<2.0.0` excludes 2.0.0; `<=2.0.0` allows it.
    if (operator === "<") continue;

    // `1.x` and `1.2.*` match a range, not a release.
    if (/^[.*xX]/.test(trimmed.slice(match.index + whole.length))) continue;

    return version;
  }

  return "unknown";
}

/**
 * Parses a package.json file content to extract dependencies.
 */
function parsePackageJson(content: string, filePath: string): Dependency[] {
  try {
    const parsed = JSON.parse(content);
    const deps: Dependency[] = [];

    const allDeps = { ...parsed.dependencies, ...parsed.devDependencies };
    for (const [name, version] of Object.entries(allDeps)) {
      if (typeof version === "string") {
        deps.push({
          name,
          version: normalizeNpmVersion(version),
          manifestFile: filePath,
          ecosystem: "npm",
        });
      }
    }
    return deps;
  } catch (error) {
    console.error(`[SBOM] Failed to parse ${filePath}:`, error);
    return [];
  }
}

/**
 * A requirement name, optional extras, and the remainder of the line.
 *
 * PEP 508 names may contain dots, underscores and hyphens, and must start and
 * end with an alphanumeric character. The previous pattern stopped at the first
 * dot, so `zope.interface` was read as `zope`.
 */
const REQUIREMENT_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:\s*\[[^\]]*\])?\s*(.*)$/;

/** A concrete version after one of the comparison operators pip accepts. */
const REQUIREMENT_VERSION = /^(===|==|~=|!=|<=|>=|<|>)\s*([^\s,;]+)/;

/** Operators whose named version is outside the set the project accepts. */
const EXCLUSION_OPERATORS = new Set(["!=", "<"]);

/**
 * Parses a requirements.txt file content to extract dependencies.
 */
function parseRequirementsTxt(content: string, filePath: string): Dependency[] {
  const deps: Dependency[] = [];
  const lines = content.split("\n");

  for (const rawLine of lines) {
    let trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // pip treats a hash preceded by whitespace as a comment. A URL fragment
    // such as `#egg=name` has no preceding whitespace and must survive.
    const commentAt = trimmed.search(/\s#/);
    if (commentAt !== -1) trimmed = trimmed.slice(0, commentAt).trim();
    if (!trimmed) continue;

    // Option lines (`-r`, `-c`, `--index-url`, ...) and bare archive/VCS URLs
    // name no package. The old parser read `https` as a package name.
    if (trimmed.startsWith("-")) continue;
    if (/^(?:https?|git\+[a-z]+|ssh|file):/i.test(trimmed)) continue;

    const nameMatch = trimmed.match(REQUIREMENT_NAME);
    if (!nameMatch) continue;

    const name = nameMatch[1].toLowerCase();
    let rest = nameMatch[2].trim();

    // A direct reference (`package @ https://...`) has no version OSV can match.
    if (rest.startsWith("@")) {
      deps.push({ name, version: "unknown", manifestFile: filePath, ecosystem: "pypi" });
      continue;
    }

    // Environment markers start at the first semicolon. They constrain where a
    // requirement applies, not which version is installed.
    const markerAt = rest.indexOf(";");
    if (markerAt !== -1) rest = rest.slice(0, markerAt).trim();

    const versionMatch = rest.match(REQUIREMENT_VERSION);
    if (!versionMatch) {
      deps.push({ name, version: "unknown", manifestFile: filePath, ecosystem: "pypi" });
      continue;
    }

    const [, operator, version] = versionMatch;

    // `!=1.2.3` and `<1.2.3` name versions the project explicitly excludes. The
    // old code dropped the operator and queried the excluded version as though
    // it were installed, producing false positives.
    if (
      EXCLUSION_OPERATORS.has(operator) ||
      version.includes("*") ||
      /(^|\.)[xX](\.|$)/.test(version)
    ) {
      deps.push({ name, version: "unknown", manifestFile: filePath, ecosystem: "pypi" });
      continue;
    }

    deps.push({ name, version, manifestFile: filePath, ecosystem: "pypi" });
  }
  return deps;
}

/**
 * Main parser function that routes to the correct parser based on file extension.
 */
export function parseManifestFile(content: string, filePath: string): Dependency[] {
  if (filePath.endsWith("package-lock.json")) {
    return parsePackageLockJson(content, filePath);
  }
  if (filePath.endsWith("pnpm-lock.yaml")) {
    return parsePnpmLockYaml(content, filePath);
  }
  if (filePath.endsWith("yarn.lock")) {
    return parseYarnLock(content, filePath);
  }
  if (filePath.endsWith("Cargo.lock")) {
    return parseCargoLock(content, filePath);
  }
  if (filePath.endsWith("go.sum")) {
    return parseGoSum(content, filePath);
  }
  if (filePath.endsWith("package.json")) {
    return parsePackageJson(content, filePath);
  }
  if (filePath.endsWith("requirements.txt")) {
    return parseRequirementsTxt(content, filePath);
  }
  if (isSbomManifest(filePath)) {
    return parseSbomFile(content, filePath);
  }
  return [];
}

function parseSbomFile(content: string, filePath: string): Dependency[] {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    log.warn("SBOM file is not valid JSON", { filePath });
    return [];
  }

  const result = detectAndParseSbom(doc, filePath);
  if (!result) {
    log.warn("JSON file does not match CycloneDX or SPDX format", { filePath });
    return [];
  }

  for (const warning of result.warnings) {
    log.warn(`SBOM parse warning: ${warning}`, { filePath, format: result.format });
  }

  return result.dependencies;
}
