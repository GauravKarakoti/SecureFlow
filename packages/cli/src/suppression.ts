/**
 * Inline Comment Suppression Directive Engine for SecureFlow CLI (#2051)
 *
 * Allows developers to suppress known false positives or intentional test fixtures
 * directly in source code using inline comment directives.
 *
 * Supported syntaxes:
 *   // secureflow-ignore: <reason>
 *   # secureflow-ignore: <reason>
 *   /* secureflow-ignore: <reason> * /
 *
 * Attributes:
 *   [expires=YYYY-MM-DD]
 *   [rule=<ruleId>]
 *
 * Examples:
 *   console.log(mockKey); // secureflow-ignore: intentional mock key in test fixture
 *   // secureflow-ignore[expires=2026-12-31]: legacy dev secret pending deprecation
 *   # secureflow-ignore[rule=SECUREFLOW-001]: local testing environment variable
 */

import type { Violation } from "./scanner.js";

export interface InlineDirective {
  /** 1-based line number where the directive comment resides */
  line: number;
  /** Extracted justification reason */
  reason: string;
  /** Whether a non-empty justification reason was supplied */
  hasReason: boolean;
  /** Raw expiration string (e.g. "2026-12-31") if present */
  rawExpiry?: string | undefined;
  /** Parsed UTC Date for expiration, or null if unparseable */
  expiresDate?: Date | undefined;
  /** Specific rule target (e.g. "SECUREFLOW-001") if specified */
  rule?: string | undefined;
  /** True if directive has an invalid format or expired date */
  isValid: boolean;
  /** If invalid, explanation of why directive was rejected */
  rejectionReason?: string | undefined;
}

export interface InlineSuppressionOptions {
  /** Current time for testing expiration (defaults to new Date()) */
  now?: Date | undefined;
  /** If true, directives are ignored and all violations remain active */
  ignoreSuppressions?: boolean | undefined;
}

export interface SuppressionMatchResult {
  isSuppressed: boolean;
  directive?: InlineDirective | undefined;
  rejectionReason?: string | undefined;
}

/**
 * Matches inline suppression directives across comments:
 * - Group 1: optional attribute bracket content e.g. [expires=2026-12-31,rule=SECUREFLOW-001]
 * - Group 2: optional justification reason following colon
 */
export const DIRECTIVE_REGEX =
  /(?:^|\s)(?:\/\/|#|\/\*)\s*secureflow-ignore(?:\s*\[([^\]]*)\])?(?:\s*:\s*(.*?))?(?:\s*\*\/)?$/i;

/**
 * Parse and validate a calendar date in YYYY-MM-DD format (UTC).
 * Validates days in month (including leap years) and requires exact matching.
 */
export function parseIsoDateUtc(dateStr: string): Date | null {
  const trimmed = dateStr.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;

  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10);
  const day = parseInt(match[3]!, 10);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

/**
 * Parses a single line for an inline suppression directive.
 * Returns null if no directive pattern is found.
 */
export function parseInlineDirective(
  lineText: string,
  lineNum: number,
  now: Date = new Date(),
): InlineDirective | null {
  const match = DIRECTIVE_REGEX.exec(lineText);
  if (!match) return null;

  const bracketContent = match[1]?.trim();
  const rawReason = match[2]?.trim() || "";
  const hasReason = rawReason.length > 0;

  let rawExpiry: string | undefined;
  let rule: string | undefined;

  if (bracketContent) {
    const parts = bracketContent.split(/[,;]+/);
    for (const part of parts) {
      const eqIdx = part.indexOf("=");
      if (eqIdx !== -1) {
        const key = part.slice(0, eqIdx).trim().toLowerCase();
        const val = part.slice(eqIdx + 1).trim();
        if (key === "expires" && val) {
          rawExpiry = val;
        } else if (key === "rule" && val) {
          rule = val;
        }
      }
    }
  }

  let isValid = true;
  let rejectionReason: string | undefined;
  let expiresDate: Date | undefined;

  if (!hasReason) {
    isValid = false;
    rejectionReason = "Missing required suppression justification reason";
  } else if (rawExpiry) {
    const parsed = parseIsoDateUtc(rawExpiry);
    if (!parsed) {
      isValid = false;
      rejectionReason = `Malformed expiration date "${rawExpiry}" (expected YYYY-MM-DD)`;
    } else {
      expiresDate = parsed;
      if (now.getTime() > parsed.getTime()) {
        isValid = false;
        rejectionReason = `Suppression directive expired on ${rawExpiry}`;
      }
    }
  }

  return {
    line: lineNum,
    reason: rawReason,
    hasReason,
    rawExpiry,
    expiresDate,
    rule,
    isValid,
    rejectionReason,
  };
}

/**
 * Scans entire content line-by-line to collect all inline directives.
 */
export function parseAllDirectives(
  content: string,
  now: Date = new Date(),
): Map<number, InlineDirective> {
  const directives = new Map<number, InlineDirective>();
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const lineText = lines[i]!;
    const directive = parseInlineDirective(lineText, lineNum, now);
    if (directive) {
      directives.set(lineNum, directive);
    }
  }

  return directives;
}

/**
 * Checks if a violation rule matches an optional directive rule filter.
 */
function matchesRule(violationReason: string, directiveRule?: string): boolean {
  if (!directiveRule) return true;
  const target = directiveRule.toLowerCase().trim();
  const actual = violationReason.toLowerCase().trim();
  return actual.includes(target) || target.includes(actual);
}

/**
 * Determines whether a violation is suppressed by a directive on the same line (trailing)
 * or on the immediately preceding line.
 */
export function isViolationSuppressed(
  violation: Violation,
  directivesByLine: Map<number, InlineDirective>,
  options?: InlineSuppressionOptions,
): SuppressionMatchResult {
  if (options?.ignoreSuppressions) {
    return { isSuppressed: false };
  }

  // Check 1: Directive on the same line as the violation (trailing comment)
  const sameLineDirective = directivesByLine.get(violation.line);
  if (sameLineDirective) {
    if (matchesRule(violation.reason, sameLineDirective.rule)) {
      if (!sameLineDirective.isValid) {
        return {
          isSuppressed: false,
          directive: sameLineDirective,
          rejectionReason: sameLineDirective.rejectionReason,
        };
      }
      return {
        isSuppressed: true,
        directive: sameLineDirective,
      };
    }
  }

  // Check 2: Directive on the immediately preceding line
  if (violation.line > 1) {
    const prevLineDirective = directivesByLine.get(violation.line - 1);
    if (prevLineDirective) {
      if (matchesRule(violation.reason, prevLineDirective.rule)) {
        if (!prevLineDirective.isValid) {
          return {
            isSuppressed: false,
            directive: prevLineDirective,
            rejectionReason: prevLineDirective.rejectionReason,
          };
        }
        return {
          isSuppressed: true,
          directive: prevLineDirective,
        };
      }
    }
  }

  return { isSuppressed: false };
}

/**
 * Applies inline suppressions to a list of violations for a given file content.
 * Returns partitioned active and suppressed violations.
 */
export function applyInlineSuppressions(
  violations: Violation[],
  content: string,
  options?: InlineSuppressionOptions,
): { activeViolations: Violation[]; suppressedViolations: Violation[] } {
  if (!violations || violations.length === 0) {
    return { activeViolations: [], suppressedViolations: [] };
  }

  if (options?.ignoreSuppressions) {
    return { activeViolations: [...violations], suppressedViolations: [] };
  }

  const now = options?.now || new Date();
  const directives = parseAllDirectives(content, now);

  const activeViolations: Violation[] = [];
  const suppressedViolations: Violation[] = [];

  for (const violation of violations) {
    const match = isViolationSuppressed(violation, directives, options);
    if (match.isSuppressed && match.directive) {
      const suppressed: Violation = {
        ...violation,
        suppression: {
          reason: match.directive.reason,
          expires: match.directive.rawExpiry,
          line: match.directive.line,
        },
      };
      suppressedViolations.push(suppressed);
    } else {
      activeViolations.push(violation);
    }
  }

  return { activeViolations, suppressedViolations };
}
