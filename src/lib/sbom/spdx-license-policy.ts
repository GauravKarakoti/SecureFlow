/**
 * SPDX License Expression Parser & Copyleft Compliance Policy Engine (#2079).
 *
 * Implements a recursive-descent parser for SPDX 2.x/3.0 compound boolean
 * license expressions (`AND`, `OR`, `WITH` exceptions, `+` modifiers, parentheses)
 * and evaluates parsed ASTs against organization license compliance policies.
 */

import type { Dependency } from "@/types/sbom";

export type LicenseCategory =
  "permissive" | "public-domain" | "weak-copyleft" | "strong-copyleft" | "proprietary" | "unknown";

export type SpdxAstNode =
  | { type: "license"; id: string; plus: boolean }
  | { type: "with"; license: { type: "license"; id: string; plus: boolean }; exception: string }
  | { type: "and"; left: SpdxAstNode; right: SpdxAstNode }
  | { type: "or"; left: SpdxAstNode; right: SpdxAstNode };

export class SpdxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpdxParseError";
  }
}

export interface LicensePolicyConfig {
  name: string;
  /** Explicitly permitted SPDX IDs (case-insensitive). Overrides category blocks. */
  allowlist?: readonly string[];
  /** Explicitly forbidden SPDX IDs (case-insensitive). Always fails even if permissive. */
  denylist?: readonly string[];
  /** Block strong copyleft licenses (GPL, AGPL, SSPL, etc.). */
  blockStrongCopyleft?: boolean;
  /** Flag weak copyleft licenses (LGPL, MPL, EPL, etc.) as warnings or failures. */
  blockWeakCopyleft?: boolean;
  /** Whether unrecognized / NOASSERTION licenses fail compliance. */
  allowUnknown?: boolean;
}

export const PERMISSIVE_ONLY_POLICY: LicensePolicyConfig = {
  name: "permissive-only",
  blockStrongCopyleft: true,
  blockWeakCopyleft: true,
  allowUnknown: false,
};

export const STANDARD_OSS_POLICY: LicensePolicyConfig = {
  name: "standard-oss",
  blockStrongCopyleft: true,
  blockWeakCopyleft: false,
  allowUnknown: true,
};

export interface LicenseEvaluationResult {
  expression: string;
  compliant: boolean;
  severity: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  categories: LicenseCategory[];
  violatingLicenses: string[];
  satisfiedBy: string[];
  reason: string;
}

export interface DependencyLicenseViolation {
  dependency: Dependency;
  expression: string;
  evaluation: LicenseEvaluationResult;
}

export interface SbomLicenseComplianceSummary {
  policyName: string;
  totalDependencies: number;
  compliantCount: number;
  violationCount: number;
  unknownCount: number;
  violations: DependencyLicenseViolation[];
}

const PERMISSIVE_IDS = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-CLAUSE",
  "BSD-3-CLAUSE",
  "BSD-3-CLAUSE-CLEAR",
  "APACHE-2.0",
  "ZLIB",
  "BSL-1.0",
  "ARTISTIC-2.0",
  "NCSA",
  "PYTHON-2.0",
  "PSF-2.0",
  "BLUEOAK-1.0.0",
  "0BSD",
]);

const PUBLIC_DOMAIN_IDS = new Set(["CC0-1.0", "UNLICENSE", "WTFPL"]);

const WEAK_COPYLEFT_IDS = new Set([
  "LGPL-2.0-ONLY",
  "LGPL-2.0-OR-LATER",
  "LGPL-2.1-ONLY",
  "LGPL-2.1-OR-LATER",
  "LGPL-3.0-ONLY",
  "LGPL-3.0-OR-LATER",
  "LGPL-2.1",
  "LGPL-3.0",
  "MPL-1.1",
  "MPL-2.0",
  "EPL-1.0",
  "EPL-2.0",
  "CDDL-1.0",
  "CDDL-1.1",
  "EUPL-1.1",
  "EUPL-1.2",
  "CC-BY-SA-4.0",
]);

const STRONG_COPYLEFT_IDS = new Set([
  "GPL-1.0-ONLY",
  "GPL-1.0-OR-LATER",
  "GPL-2.0-ONLY",
  "GPL-2.0-OR-LATER",
  "GPL-3.0-ONLY",
  "GPL-3.0-OR-LATER",
  "GPL-2.0",
  "GPL-3.0",
  "AGPL-1.0-ONLY",
  "AGPL-3.0-ONLY",
  "AGPL-3.0-OR-LATER",
  "AGPL-3.0",
  "SSPL-1.0",
  "OSL-3.0",
  "CPAL-1.0",
  "SLEEPYCAT",
]);

/**
 * Classifies a single SPDX license identifier into a compliance category.
 */
export function classifySpdxLicense(licenseId: string): LicenseCategory {
  const normalized = licenseId.trim().toUpperCase().replace(/\+$/, "");
  if (!normalized || normalized === "NOASSERTION" || normalized === "NONE") {
    return "unknown";
  }
  if (normalized.startsWith("LICENSEREF-PROPRIETARY") || normalized === "PROPRIETARY") {
    return "proprietary";
  }
  if (PERMISSIVE_IDS.has(normalized)) return "permissive";
  if (PUBLIC_DOMAIN_IDS.has(normalized)) return "public-domain";
  if (WEAK_COPYLEFT_IDS.has(normalized)) return "weak-copyleft";
  if (STRONG_COPYLEFT_IDS.has(normalized)) return "strong-copyleft";

  // Heuristic fallback for versioned GPL/AGPL/LGPL variants
  if (/^AGPL-|^SSPL-|^GPL-/.test(normalized)) return "strong-copyleft";
  if (/^LGPL-|^MPL-|^EPL-/.test(normalized)) return "weak-copyleft";

  return "unknown";
}

type Token =
  | { kind: "LPAREN" }
  | { kind: "RPAREN" }
  | { kind: "AND" }
  | { kind: "OR" }
  | { kind: "WITH" }
  | { kind: "ID"; value: string; plus: boolean };

function tokenizeSpdx(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = expression.length;

  while (i < len) {
    const ch = expression[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "LPAREN" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "RPAREN" });
      i++;
      continue;
    }

    let end = i;
    while (end < len && !/[\s()]/.test(expression[end]!)) {
      end++;
    }
    const word = expression.slice(i, end);
    i = end;

    if (word === "AND") {
      tokens.push({ kind: "AND" });
    } else if (word === "OR") {
      tokens.push({ kind: "OR" });
    } else if (word === "WITH") {
      tokens.push({ kind: "WITH" });
    } else if (word.endsWith("+") && word.length > 1) {
      tokens.push({ kind: "ID", value: word.slice(0, -1), plus: true });
    } else {
      tokens.push({ kind: "ID", value: word, plus: false });
    }
  }

  return tokens;
}

/**
 * Recursive-descent parser for SPDX license expressions.
 * Operator precedence: `WITH` > `AND` > `OR` (left-associative).
 */
export function parseSpdxExpression(expression: string): SpdxAstNode {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new SpdxParseError("SPDX license expression cannot be empty");
  }

  const tokens = tokenizeSpdx(trimmed);
  let pos = 0;

  function peek(): Token | undefined {
    return tokens[pos];
  }

  function consume(): Token {
    const tok = tokens[pos];
    if (!tok) {
      throw new SpdxParseError("Unexpected end of SPDX expression");
    }
    pos++;
    return tok;
  }

  function parseOr(): SpdxAstNode {
    let left = parseAnd();
    while (peek()?.kind === "OR") {
      consume();
      const right = parseAnd();
      left = { type: "or", left, right };
    }
    return left;
  }

  function parseAnd(): SpdxAstNode {
    let left = parseAtom();
    while (peek()?.kind === "AND") {
      consume();
      const right = parseAtom();
      left = { type: "and", left, right };
    }
    return left;
  }

  function parseAtom(): SpdxAstNode {
    const next = peek();
    if (!next) {
      throw new SpdxParseError("Expected license identifier or '(' in SPDX expression");
    }

    if (next.kind === "LPAREN") {
      consume();
      const inner = parseOr();
      const closing = peek();
      if (!closing || closing.kind !== "RPAREN") {
        throw new SpdxParseError("Unclosed '(' in SPDX expression");
      }
      consume();
      return inner;
    }

    if (next.kind !== "ID") {
      throw new SpdxParseError(`Unexpected operator '${next.kind}' in SPDX expression`);
    }

    consume();
    const licenseNode: { type: "license"; id: string; plus: boolean } = {
      type: "license",
      id: next.value,
      plus: next.plus,
    };

    if (peek()?.kind === "WITH") {
      consume();
      const exc = peek();
      if (!exc || exc.kind !== "ID") {
        throw new SpdxParseError("Expected exception identifier after WITH");
      }
      consume();
      return {
        type: "with",
        license: licenseNode,
        exception: exc.value,
      };
    }

    return licenseNode;
  }

  const ast = parseOr();
  if (pos < tokens.length) {
    throw new SpdxParseError(`Unexpected trailing token '${tokens[pos]!.kind}' in SPDX expression`);
  }
  return ast;
}

interface BranchOutcome {
  compliant: boolean;
  categories: Set<LicenseCategory>;
  violating: Set<string>;
  satisfiedBy: Set<string>;
}

function evaluateSingleLicense(
  id: string,
  policy: LicensePolicyConfig,
  hasException = false,
): BranchOutcome {
  const upper = id.toUpperCase();
  const category = classifySpdxLicense(id);
  const categories = new Set<LicenseCategory>([category]);
  const allowlist = new Set((policy.allowlist ?? []).map((x) => x.toUpperCase()));
  const denylist = new Set((policy.denylist ?? []).map((x) => x.toUpperCase()));

  if (denylist.has(upper)) {
    return {
      compliant: false,
      categories,
      violating: new Set([id]),
      satisfiedBy: new Set(),
    };
  }

  if (allowlist.has(upper)) {
    return {
      compliant: true,
      categories,
      violating: new Set(),
      satisfiedBy: new Set([id]),
    };
  }

  if (category === "proprietary") {
    return {
      compliant: false,
      categories,
      violating: new Set([id]),
      satisfiedBy: new Set(),
    };
  }

  if (category === "strong-copyleft" && policy.blockStrongCopyleft !== false) {
    // e.g. GPL-2.0 WITH Classpath-exception-2.0 is still flagged unless allowlisted
    void hasException;
    return {
      compliant: false,
      categories,
      violating: new Set([id]),
      satisfiedBy: new Set(),
    };
  }

  if (category === "weak-copyleft" && policy.blockWeakCopyleft === true) {
    return {
      compliant: false,
      categories,
      violating: new Set([id]),
      satisfiedBy: new Set(),
    };
  }

  if (category === "unknown" && policy.allowUnknown === false) {
    return {
      compliant: false,
      categories,
      violating: new Set([id]),
      satisfiedBy: new Set(),
    };
  }

  return {
    compliant: true,
    categories,
    violating: new Set(),
    satisfiedBy: new Set([id]),
  };
}

function evaluateAst(node: SpdxAstNode, policy: LicensePolicyConfig): BranchOutcome {
  switch (node.type) {
    case "license":
      return evaluateSingleLicense(node.id, policy, false);
    case "with":
      return evaluateSingleLicense(node.license.id, policy, true);
    case "and": {
      const l = evaluateAst(node.left, policy);
      const r = evaluateAst(node.right, policy);
      const compliant = l.compliant && r.compliant;
      return {
        compliant,
        categories: new Set([...l.categories, ...r.categories]),
        violating: new Set([...l.violating, ...r.violating]),
        satisfiedBy: compliant ? new Set([...l.satisfiedBy, ...r.satisfiedBy]) : new Set(),
      };
    }
    case "or": {
      const l = evaluateAst(node.left, policy);
      const r = evaluateAst(node.right, policy);
      // Dual-licensed OR: compliant if EITHER branch satisfies the policy
      if (l.compliant && r.compliant) {
        return {
          compliant: true,
          categories: new Set([...l.categories, ...r.categories]),
          violating: new Set(),
          satisfiedBy: new Set([...l.satisfiedBy, ...r.satisfiedBy]),
        };
      }
      if (l.compliant) {
        return {
          compliant: true,
          categories: l.categories,
          violating: new Set(),
          satisfiedBy: l.satisfiedBy,
        };
      }
      if (r.compliant) {
        return {
          compliant: true,
          categories: r.categories,
          violating: new Set(),
          satisfiedBy: r.satisfiedBy,
        };
      }
      return {
        compliant: false,
        categories: new Set([...l.categories, ...r.categories]),
        violating: new Set([...l.violating, ...r.violating]),
        satisfiedBy: new Set(),
      };
    }
  }
}

/**
 * Evaluates an SPDX license expression string against a compliance policy.
 */
export function evaluateLicensePolicy(
  expression: string | undefined | null,
  policy: LicensePolicyConfig = STANDARD_OSS_POLICY,
): LicenseEvaluationResult {
  const raw = (expression ?? "").trim();
  if (!raw || raw.toUpperCase() === "NOASSERTION" || raw.toUpperCase() === "NONE") {
    const compliant = policy.allowUnknown !== false;
    return {
      expression: raw || "NOASSERTION",
      compliant,
      severity: compliant ? "NONE" : "MEDIUM",
      categories: ["unknown"],
      violatingLicenses: compliant ? [] : [raw || "NOASSERTION"],
      satisfiedBy: [],
      reason: compliant
        ? "License unknown/unasserted (permitted by policy)"
        : "Missing or unasserted license is disallowed by policy",
    };
  }

  let ast: SpdxAstNode;
  try {
    ast = parseSpdxExpression(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid SPDX expression";
    const compliant = policy.allowUnknown !== false;
    return {
      expression: raw,
      compliant,
      severity: compliant ? "NONE" : "MEDIUM",
      categories: ["unknown"],
      violatingLicenses: compliant ? [] : [raw],
      satisfiedBy: [],
      reason: `Unparseable license expression (${msg})`,
    };
  }

  const outcome = evaluateAst(ast, policy);
  const categories = [...outcome.categories];
  const violatingLicenses = [...outcome.violating];
  const satisfiedBy = [...outcome.satisfiedBy];

  let severity: LicenseEvaluationResult["severity"] = "NONE";
  if (!outcome.compliant) {
    if (categories.includes("strong-copyleft") || categories.includes("proprietary")) {
      severity = "HIGH";
    } else if (categories.includes("weak-copyleft")) {
      severity = "MEDIUM";
    } else {
      severity = "LOW";
    }
  }

  return {
    expression: raw,
    compliant: outcome.compliant,
    severity,
    categories,
    violatingLicenses,
    satisfiedBy,
    reason: outcome.compliant
      ? `Satisfies policy '${policy.name}' (${satisfiedBy.join(", ")})`
      : `Violates policy '${policy.name}': disallowed license(s) [${violatingLicenses.join(", ")}]`,
  };
}

/**
 * Evaluates license compliance across all extracted SBOM dependencies.
 */
export function evaluateDependenciesLicenses(
  dependencies: readonly Dependency[],
  policy: LicensePolicyConfig = STANDARD_OSS_POLICY,
): SbomLicenseComplianceSummary {
  const violations: DependencyLicenseViolation[] = [];
  let compliantCount = 0;
  let unknownCount = 0;

  for (const dep of dependencies) {
    const evaluation = evaluateLicensePolicy(dep.license, policy);
    if (evaluation.categories.includes("unknown")) {
      unknownCount++;
    }
    if (evaluation.compliant) {
      compliantCount++;
    } else {
      violations.push({
        dependency: dep,
        expression: evaluation.expression,
        evaluation,
      });
    }
  }

  return {
    policyName: policy.name,
    totalDependencies: dependencies.length,
    compliantCount,
    violationCount: violations.length,
    unknownCount,
    violations,
  };
}
