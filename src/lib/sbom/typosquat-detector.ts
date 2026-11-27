import type { Dependency, SeverityLevel } from "@/types/sbom";

/**
 * Deterministic Typosquatting, Homoglyph & Dependency Confusion Detector (#2176).
 *
 * Operates 100% offline using Damerau-Levenshtein edit distance, Unicode/ASCII
 * confusable normalization, affix impersonation checks, and dependency-confusion
 * version/scope heuristics.
 */

export type SupplyChainRiskKind =
  "typosquat" | "homoglyph" | "affix-impersonation" | "dependency-confusion";

export interface TyposquatRisk {
  dependency: Dependency;
  kind: SupplyChainRiskKind;
  severity: SeverityLevel;
  targetPackage?: string;
  editDistance?: number;
  reason: string;
}

export interface TyposquatDetectorOptions {
  /** Additional protected/popular package names to guard per ecosystem. */
  protectedPackages?: Partial<Record<Dependency["ecosystem"], readonly string[]>>;
  /** Internal package names or scope prefixes to guard against dependency confusion. */
  internalPackages?: readonly string[];
  /** Maximum Damerau-Levenshtein edit distance threshold (default: 1 for len<8, 2 for len>=8). */
  maxDistance?: number;
}

const POPULAR_PACKAGES: Record<Dependency["ecosystem"], readonly string[]> = {
  npm: [
    "lodash",
    "express",
    "react",
    "react-dom",
    "axios",
    "chalk",
    "commander",
    "webpack",
    "typescript",
    "eslint",
    "prettier",
    "moment",
    "dayjs",
    "uuid",
    "zod",
    "jsonwebtoken",
    "bcrypt",
    "mongoose",
    "sequelize",
    "prisma",
    "next",
    "dotenv",
    "cors",
    "helmet",
    "winston",
    "minimist",
    "semver",
    "glob",
    "rimraf",
    "cross-env",
  ],
  pypi: [
    "requests",
    "urllib3",
    "numpy",
    "pandas",
    "scipy",
    "flask",
    "django",
    "fastapi",
    "pydantic",
    "sqlalchemy",
    "boto3",
    "botocore",
    "cryptography",
    "pyyaml",
    "pillow",
    "pytest",
    "setuptools",
    "certifi",
    "idna",
    "chardet",
    "jinja2",
    "aiohttp",
    "httpx",
  ],
  cargo: [
    "serde",
    "serde_json",
    "tokio",
    "clap",
    "rand",
    "reqwest",
    "hyper",
    "regex",
    "chrono",
    "anyhow",
    "thiserror",
    "tracing",
    "axum",
  ],
  go: [
    "github.com/gin-gonic/gin",
    "github.com/stretchr/testify",
    "github.com/gorilla/mux",
    "github.com/spf13/cobra",
    "golang.org/x/crypto",
    "google.golang.org/grpc",
  ],
  maven: [
    "org.apache.logging.log4j:log4j-core",
    "com.fasterxml.jackson.core:jackson-databind",
    "org.springframework.boot:spring-boot-starter-web",
  ],
  gem: ["rails", "rake", "rspec", "devise", "puma", "nokogiri", "faraday"],
};

const IMPERSONATION_PREFIXES = ["node-", "js-", "py-", "python-", "npm-", "go-"];
const IMPERSONATION_SUFFIXES = ["-js", "-node", "-py", "-python", "-npm", "-sdk", "-cli"];

const CONFUSABLE_CHAR_MAP: Record<string, string> = {
  "0": "o",
  "1": "l",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "\u0430": "a", // Cyrillic а
  "\u0435": "e", // Cyrillic е
  "\u043e": "o", // Cyrillic о
  "\u0440": "p", // Cyrillic р
  "\u0441": "c", // Cyrillic с
  "\u0445": "x", // Cyrillic х
  "\u0456": "i", // Cyrillic і
};

/**
 * Computes Optimal String Alignment (Damerau-Levenshtein) distance between `a` and `b`,
 * treating adjacent character transpositions as a single edit (distance 1).
 */
export function damerauLevenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(
        dp[i - 1]![j]! + 1, // deletion
        dp[i]![j - 1]! + 1, // insertion
        dp[i - 1]![j - 1]! + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, dp[i - 2]![j - 2]! + 1); // transposition
      }
      dp[i]![j] = val;
    }
  }

  return dp[m]![n]!;
}

/**
 * Normalizes visual homoglyph/confusable characters to their canonical Latin forms.
 */
export function normalizeConfusables(name: string): string {
  let out = "";
  for (const ch of name.toLowerCase()) {
    out += CONFUSABLE_CHAR_MAP[ch] ?? ch;
  }
  return out.replace(/rn/g, "m");
}

function isSuspiciousConfusionVersion(version: string): boolean {
  const clean = version.trim().toLowerCase();
  if (clean === "0.0.1-security" || clean === "0.0.0-security") return true;
  const majorMatch = /^v?(\d+)\./.exec(clean);
  if (majorMatch) {
    const major = parseInt(majorMatch[1]!, 10);
    if (major >= 99) return true;
  }
  return false;
}

function stripScope(pkgName: string): string {
  if (pkgName.startsWith("@")) {
    const slash = pkgName.indexOf("/");
    if (slash > 0) return pkgName.slice(slash + 1);
  }
  return pkgName;
}

/**
 * Analyzes an array of SBOM dependencies for offline typosquatting, homoglyph,
 * affix impersonation, and dependency-confusion supply-chain risks.
 */
export function detectTyposquatRisks(
  dependencies: readonly Dependency[],
  options: TyposquatDetectorOptions = {},
): TyposquatRisk[] {
  const risks: TyposquatRisk[] = [];
  const internalSet = new Set<string>();
  for (const pkg of options.internalPackages ?? []) {
    const lower = pkg.trim().toLowerCase();
    if (!lower) continue;
    internalSet.add(lower);
    internalSet.add(stripScope(lower));
  }

  for (const dep of dependencies) {
    const nameLower = dep.name.trim().toLowerCase();
    if (!nameLower) continue;

    // 1. Dependency confusion heuristics (high major >= 99 or internal package collision)
    if (isSuspiciousConfusionVersion(dep.version)) {
      risks.push({
        dependency: dep,
        kind: "dependency-confusion",
        severity: "CRITICAL",
        reason: `Package '${dep.name}@${dep.version}' uses a suspicious hijack/confusion version pattern (>=99.x or security placeholder).`,
      });
      continue;
    }

    const unscoped = stripScope(nameLower);
    if (internalSet.has(nameLower) || (!nameLower.startsWith("@") && internalSet.has(unscoped))) {
      risks.push({
        dependency: dep,
        kind: "dependency-confusion",
        severity: "CRITICAL",
        targetPackage: dep.name,
        reason: `Package '${dep.name}' matches an internal package name and may be vulnerable to public registry dependency confusion.`,
      });
      continue;
    }

    const protectedList = [
      ...(POPULAR_PACKAGES[dep.ecosystem] ?? []),
      ...(options.protectedPackages?.[dep.ecosystem] ?? []),
    ];
    const protectedSet = new Set(protectedList.map((p) => p.toLowerCase()));

    // Exact legitimate package match -> never flag
    if (protectedSet.has(nameLower)) {
      continue;
    }

    // 2. Homoglyph / confusable impersonation
    const confusableNorm = normalizeConfusables(nameLower);
    if (confusableNorm !== nameLower && protectedSet.has(confusableNorm)) {
      risks.push({
        dependency: dep,
        kind: "homoglyph",
        severity: "CRITICAL",
        targetPackage: confusableNorm,
        reason: `Package '${dep.name}' uses visual homoglyph/confusable characters impersonating '${confusableNorm}'.`,
      });
      continue;
    }

    // 3. Affix impersonation (e.g. lodash-js, node-lodash, py-requests)
    let affixTarget: string | null = null;
    for (const prefix of IMPERSONATION_PREFIXES) {
      if (nameLower.startsWith(prefix)) {
        const candidate = nameLower.slice(prefix.length);
        if (protectedSet.has(candidate)) {
          affixTarget = candidate;
          break;
        }
      }
    }
    if (!affixTarget) {
      for (const suffix of IMPERSONATION_SUFFIXES) {
        if (nameLower.endsWith(suffix)) {
          const candidate = nameLower.slice(0, -suffix.length);
          if (protectedSet.has(candidate)) {
            affixTarget = candidate;
            break;
          }
        }
      }
    }
    if (affixTarget) {
      risks.push({
        dependency: dep,
        kind: "affix-impersonation",
        severity: "HIGH",
        targetPackage: affixTarget,
        reason: `Package '${dep.name}' closely resembles popular package '${affixTarget}' via common impersonation affix.`,
      });
      continue;
    }

    // 4. Damerau-Levenshtein edit-distance typosquatting (skip very short names < 4 chars)
    if (nameLower.length < 4) continue;

    let bestTarget: string | null = null;
    let bestDist = Infinity;

    for (const target of protectedSet) {
      if (target.length < 4) continue;
      const threshold = options.maxDistance ?? (target.length >= 8 ? 2 : 1);
      if (Math.abs(nameLower.length - target.length) > threshold) continue;

      const dist = damerauLevenshtein(nameLower, target);
      if (dist > 0 && dist <= threshold && dist < bestDist) {
        bestDist = dist;
        bestTarget = target;
      }
    }

    if (bestTarget) {
      risks.push({
        dependency: dep,
        kind: "typosquat",
        severity: "HIGH",
        targetPackage: bestTarget,
        editDistance: bestDist,
        reason: `Package '${dep.name}' is within Damerau-Levenshtein edit distance ${bestDist} of popular package '${bestTarget}'.`,
      });
    }
  }

  return risks;
}
