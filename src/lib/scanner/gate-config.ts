/**
 * Configuration for the server-side PR policy gate.
 *
 * Maintainers can configure the gate with `.secureflow.json` at the repository root,
 * read from the PR's base branch (never from the head branch).
 *
 * Implements Issue #1491 & #1470.
 */

import { parseSeverity } from "@/lib/severity";
import { stripJsonComments } from "secureflow-cli/contracts";
import type { IgnoreConfigClient } from "./ignore-config";
import { resolveBaseRef } from "./ignore-config";
import { parsePolicyScopes, type PolicyScopeRule } from "./policy-scopes";
import {
  type ConfidenceLevel,
  parseConfidence,
  DEFAULT_MIN_COMMENT_CONFIDENCE,
} from "@/lib/confidence";

export { type PolicyScopeRule };

export const SECUREFLOW_CONFIG_FILE = ".secureflow.json";

/** Default scan timeout budget in seconds (#1981). */
export const DEFAULT_SCAN_TIMEOUT_BUDGET_SECONDS = 120;

/** Default scan request timeout in seconds (#1981). */
export const DEFAULT_SCAN_REQUEST_TIMEOUT_SECONDS = 60;

/** Default number of surrounding context lines around diff hunks (#2006). */
export const DEFAULT_CONTEXT_LINES = 5;

/** Maximum number of surrounding context lines allowed (#2006). */
export const MAX_CONTEXT_LINES = 20;

/** Minimum number of surrounding context lines (#2006). */
export const MIN_CONTEXT_LINES = 0;

/**
 * Resolves the number of context lines from configuration or environment (#2006).
 * Validated and capped between 0 and 20 (defaults to 5).
 */
export function resolveContextLines(
  configured?:
    | number
    | string
    | {
        contextLines?: number;
        scanner?: { contextLines?: number };
        gate?: { contextLines?: number };
      }
    | null,
): number {
  let raw: unknown = configured;
  if (configured && typeof configured === "object") {
    raw =
      configured.contextLines ?? configured.scanner?.contextLines ?? configured.gate?.contextLines;
  }
  const val =
    typeof raw === "number"
      ? raw
      : (raw ?? process.env.SCANNER_CONTEXT_LINES ?? process.env.CONTEXT_LINES)?.toString().trim();
  if (val === undefined || val === null || val === "") {
    return DEFAULT_CONTEXT_LINES;
  }
  const n = typeof val === "number" ? val : Number(val);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    console.warn(
      `[GateConfig] Invalid contextLines value '${String(val)}' (expected integer between ${MIN_CONTEXT_LINES} and ${MAX_CONTEXT_LINES}); using default ${DEFAULT_CONTEXT_LINES}.`,
    );
    return DEFAULT_CONTEXT_LINES;
  }
  if (n < MIN_CONTEXT_LINES) {
    console.warn(
      `[GateConfig] contextLines value ${n} is below minimum ${MIN_CONTEXT_LINES}; clamping to ${MIN_CONTEXT_LINES}.`,
    );
    return MIN_CONTEXT_LINES;
  }
  if (n > MAX_CONTEXT_LINES) {
    console.warn(
      `[GateConfig] contextLines value ${n} exceeds maximum ${MAX_CONTEXT_LINES}; capping at ${MAX_CONTEXT_LINES}.`,
    );
    return MAX_CONTEXT_LINES;
  }
  return n;
}

/**
 * Resolves the total scan timeout budget in milliseconds from configuration or environment (#1981).
 * Default is 120 seconds (120,000 ms).
 */
export function resolveScanTimeoutBudgetMs(
  configured?:
    | number
    | string
    | {
        timeoutBudget?: number;
        timeoutBudgetSeconds?: number;
        scanner?: { timeoutBudget?: number; timeoutBudgetSeconds?: number };
      }
    | null,
): number {
  let raw: unknown = configured;
  if (configured && typeof configured === "object") {
    raw =
      configured.timeoutBudget ??
      configured.timeoutBudgetSeconds ??
      configured.scanner?.timeoutBudget ??
      configured.scanner?.timeoutBudgetSeconds;
  }
  const val =
    typeof raw === "number"
      ? raw
      : (raw ?? process.env.SCAN_TIMEOUT_BUDGET_SECONDS)?.toString().trim();
  const n = val ? Number(val) : NaN;
  return Number.isInteger(n) && n > 0 ? n * 1000 : DEFAULT_SCAN_TIMEOUT_BUDGET_SECONDS * 1000;
}

/**
 * Resolves the per-request LLM timeout in milliseconds from configuration or environment (#1981).
 * Default is 60 seconds (60,000 ms).
 */
export function resolveScanRequestTimeoutMs(
  configured?:
    | number
    | string
    | {
        requestTimeout?: number;
        requestTimeoutSeconds?: number;
        scanner?: { requestTimeout?: number; requestTimeoutSeconds?: number };
      }
    | null,
): number {
  let raw: unknown = configured;
  if (configured && typeof configured === "object") {
    raw =
      configured.requestTimeout ??
      configured.requestTimeoutSeconds ??
      configured.scanner?.requestTimeout ??
      configured.scanner?.requestTimeoutSeconds;
  }
  const val =
    typeof raw === "number"
      ? raw
      : (raw ?? process.env.SCAN_REQUEST_TIMEOUT_SECONDS)?.toString().trim();
  const n = val ? Number(val) : NaN;
  return Number.isInteger(n) && n > 0 ? n * 1000 : DEFAULT_SCAN_REQUEST_TIMEOUT_SECONDS * 1000;
}

/** Gate threshold level including NONE (which turns that gate level off). */
export type GateLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "NONE";

/** Type-specific override configuration. */
export interface GateOverride {
  type: string;
  blockOn?: GateLevel;
  reviewOn?: GateLevel;
}

/** Path-scoped gate rule (#1557). The first matching rule in file order wins per key. */
export interface GatePathRule {
  glob: string;
  blockOn?: GateLevel;
  reviewOn?: GateLevel;
}

export interface ConfidenceConfig {
  minCommentConfidence?: ConfidenceLevel;
  minConfidence?: ConfidenceLevel;
  filterBlocking?: boolean;
}

export interface GateConfig {
  blockOn: GateLevel;
  reviewOn: GateLevel;
  overrides?: GateOverride[];
  paths?: GatePathRule[];
  policyScopes?: PolicyScopeRule[];
  minCommentConfidence?: ConfidenceLevel;
  minBlockingConfidence?: ConfidenceLevel;
  filterBlocking?: boolean;
  includeDefaults?: boolean;
  forceInclude?: string[];
  timeoutBudget?: number;
  timeoutBudgetSeconds?: number;
  requestTimeout?: number;
  requestTimeoutSeconds?: number;
  skipDrafts?: boolean;
  skipAuthors?: string[];
  contextLines?: number;
  suggestions?: boolean | { enabled?: boolean; maxSuggestions?: number; limit?: number };
  suggestedChanges?: boolean | { enabled?: boolean; maxSuggestions?: number; limit?: number };
  disabledRules?: string[];
  iacRulesEnabled?: boolean;
}

export interface RulesConfig {
  disabled?: string[];
  disabledRules?: string[];
  iac?: boolean | { enabled?: boolean; disabled?: string[]; disabledRules?: string[] };
  [ruleName: string]: unknown;
}

export interface SuggestionsConfig {
  enabled: boolean;
  maxSuggestions: number;
}

export const DEFAULT_MAX_SUGGESTIONS = 5;

export interface SecureFlowConfig {
  gate: GateConfig;
  rules?: RulesConfig;
  disabledRules?: string[];
  iac?: boolean | { enabled?: boolean; disabled?: string[]; disabledRules?: string[] };
  policyScopes?: PolicyScopeRule[];
  confidence?: ConfidenceConfig;
  minCommentConfidence?: ConfidenceLevel;
  filterBlocking?: boolean;
  includeDefaults?: boolean;
  forceInclude?: string[];
  timeoutBudget?: number;
  timeoutBudgetSeconds?: number;
  requestTimeout?: number;
  requestTimeoutSeconds?: number;
  skipDrafts?: boolean;
  skipAuthors?: string[];
  contextLines?: number;
  scanner?: {
    timeoutBudget?: number;
    timeoutBudgetSeconds?: number;
    requestTimeout?: number;
    requestTimeoutSeconds?: number;
    contextLines?: number;
  };
  skipDrafts?: boolean;
  skipAuthors?: string[];
  suggestions?: boolean | { enabled?: boolean; maxSuggestions?: number; limit?: number };
  suggestedChanges?: boolean | { enabled?: boolean; maxSuggestions?: number; limit?: number };
  ignore?: {
    includeDefaults?: boolean;
    forceInclude?: string[];
  };
}

/** Default gate thresholds when no config exists or on bad configuration. */
export const DEFAULT_GATE_CONFIG: Readonly<GateConfig> = {
  blockOn: "CRITICAL",
  reviewOn: "MEDIUM",
  overrides: [],
  minCommentConfidence: DEFAULT_MIN_COMMENT_CONFIDENCE,
  filterBlocking: false,
};

/** Helper to parse a GateLevel string case-insensitively. */
export function parseGateLevel(value: unknown): GateLevel | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  if (upper === "NONE") return "NONE";
  const parsed = parseSeverity(upper);
  if (
    parsed === "CRITICAL" ||
    parsed === "HIGH" ||
    parsed === "MEDIUM" ||
    parsed === "LOW" ||
    parsed === "NONE"
  ) {
    return parsed;
  }
  return null;
}

/**
 * Normalizes an unknown gate level to a valid GateLevel, falling back to `fallback`.
 */
export function normalizeGateLevel(value: unknown, fallback: GateLevel): GateLevel {
  return parseGateLevel(value) ?? fallback;
}

/**
 * Returns true if the given gate is identical to the default gate.
 */
export function isDefaultGate(gate?: GateConfig | null): boolean {
  if (!gate) return true;
  const sameBlock = gate.blockOn === DEFAULT_GATE_CONFIG.blockOn;
  const sameReview = gate.reviewOn === DEFAULT_GATE_CONFIG.reviewOn;
  const noOverrides = !gate.overrides || gate.overrides.length === 0;
  // #1557: a config with path rules is never the default gate.
  const noPaths = !gate.paths || gate.paths.length === 0;
  // #1868: a config with policyScopes is never the default gate.
  const noScopes = !gate.policyScopes || gate.policyScopes.length === 0;
  // #1924: confidence settings check
  const sameConfidence =
    (gate.minCommentConfidence ?? DEFAULT_GATE_CONFIG.minCommentConfidence) ===
    DEFAULT_GATE_CONFIG.minCommentConfidence;
  const sameFilterBlocking = (gate.filterBlocking ?? false) === false;
  // #1983: default ignore pattern overrides
  const sameIncludeDefaults = gate.includeDefaults === undefined || gate.includeDefaults === true;
  const noForceInclude = !gate.forceInclude || gate.forceInclude.length === 0;
  // #1981: timeout settings check
  const sameTimeoutBudget =
    (gate.timeoutBudget === undefined ||
      gate.timeoutBudget === DEFAULT_SCAN_TIMEOUT_BUDGET_SECONDS) &&
    (gate.timeoutBudgetSeconds === undefined ||
      gate.timeoutBudgetSeconds === DEFAULT_SCAN_TIMEOUT_BUDGET_SECONDS);
  const sameRequestTimeout =
    (gate.requestTimeout === undefined ||
      gate.requestTimeout === DEFAULT_SCAN_REQUEST_TIMEOUT_SECONDS) &&
    (gate.requestTimeoutSeconds === undefined ||
      gate.requestTimeoutSeconds === DEFAULT_SCAN_REQUEST_TIMEOUT_SECONDS);
  // #1982: skipDrafts and skipAuthors checks
  const sameSkipDrafts = gate.skipDrafts === undefined || gate.skipDrafts === false;
  const noSkipAuthors = !gate.skipAuthors || gate.skipAuthors.length === 0;
  // #2006: contextLines check
  const sameContextLines =
    gate.contextLines === undefined || gate.contextLines === DEFAULT_CONTEXT_LINES;
  // #2005: suggestions checks (opt-in, disabled by default)
  const sameSuggestions =
    gate.suggestions === undefined ||
    (typeof gate.suggestions === "boolean" && !gate.suggestions) ||
    (typeof gate.suggestions === "object" && !gate.suggestions?.enabled);
  // #2004: IaC rules and disabledRules checks
  const sameIac = gate.iacRulesEnabled === undefined || gate.iacRulesEnabled === true;
  const noDisabledRules = !gate.disabledRules || gate.disabledRules.length === 0;

  return (
    sameBlock &&
    sameReview &&
    noOverrides &&
    noPaths &&
    noScopes &&
    sameConfidence &&
    sameFilterBlocking &&
    sameIncludeDefaults &&
    noForceInclude &&
    sameTimeoutBudget &&
    sameRequestTimeout &&
    sameSkipDrafts &&
    noSkipAuthors &&
    sameContextLines
    sameSuggestions
    sameIac &&
    noDisabledRules
  );
}

/**
 * Formats a single-line summary of the gate configuration for check-run summaries.
 * e.g. "Gate: block on HIGH+, review on MEDIUM+ (from base branch)"
 */
export function formatGateSummaryLine(gate?: GateConfig | null): string | null {
  if (!gate || isDefaultGate(gate)) return null;

  const parts: string[] = [];
  if (gate.blockOn === "NONE") {
    parts.push("block off");
  } else {
    parts.push(`block on ${gate.blockOn}+`);
  }

  if (gate.reviewOn === "NONE") {
    parts.push("review off");
  } else {
    parts.push(`review on ${gate.reviewOn}+`);
  }

  // #1557: tell the reader that path rules are active.
  const pathRuleCount = gate.paths?.length ?? 0;
  if (pathRuleCount > 0) {
    parts.push(`${pathRuleCount} path rule${pathRuleCount === 1 ? "" : "s"} active`);
  }

  // #1868: tell the reader that policy scopes are active.
  const policyScopeCount = gate.policyScopes?.length ?? 0;
  if (policyScopeCount > 0) {
    parts.push(`${policyScopeCount} policy scope${policyScopeCount === 1 ? "" : "s"} active`);
  }

  return `Gate: ${parts.join(", ")} (from base branch)`;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parses one `gate.paths` entry (#1557). A malformed rule (not an object, a missing or
 * non-string glob, or an unknown level) is skipped with a warning, never thrown.
 */
function parsePathRule(raw: unknown, label: string): GatePathRule | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.warn(`[GateConfig] ${label} must be an object; skipping this rule.`);
    return null;
  }

  const rule = raw as Record<string, unknown>;
  if (typeof rule.glob !== "string" || !rule.glob.trim()) {
    console.warn(`[GateConfig] ${label} needs a non-empty string 'glob'; skipping this rule.`);
    return null;
  }

  const parsedRule: GatePathRule = { glob: rule.glob.trim() };

  const rawBlock = rule.blockOn ?? rule.blockAt;
  if (rawBlock !== undefined) {
    const level = parseGateLevel(rawBlock);
    if (level === null) {
      console.warn(
        `[GateConfig] ${label} has unknown blockOn '${String(rawBlock)}'; skipping this rule.`,
      );
      return null;
    }
    parsedRule.blockOn = level;
  }

  const rawReview = rule.reviewOn ?? rule.reviewAt;
  if (rawReview !== undefined) {
    const level = parseGateLevel(rawReview);
    if (level === null) {
      console.warn(
        `[GateConfig] ${label} has unknown reviewOn '${String(rawReview)}'; skipping this rule.`,
      );
      return null;
    }
    parsedRule.reviewOn = level;
  }

  return parsedRule;
}

function parsePathRules(rawPaths: unknown): GatePathRule[] {
  if (rawPaths === undefined || rawPaths === null) return [];
  if (!Array.isArray(rawPaths)) {
    console.warn(`[GateConfig] 'gate.paths' in ${SECUREFLOW_CONFIG_FILE} must be an array.`);
    return [];
  }

  const rules: GatePathRule[] = [];
  rawPaths.forEach((raw, index) => {
    const rule = parsePathRule(raw, `gate.paths[${index}]`);
    if (rule) rules.push(rule);
  });
  return rules;
}

/**
 * Parses raw JSON string into a validated GateConfig with safe fallbacks.
 * A malformed file, invalid JSON, or wrong type logs a warning and returns DEFAULT_GATE_CONFIG.
 * An unknown value for one key uses the default for that key only and logs a warning.
 */
export function parseSecureFlowConfig(rawJson: string): GateConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(rawJson));
  } catch (err) {
    console.warn(`[GateConfig] Invalid JSON in ${SECUREFLOW_CONFIG_FILE}: ${describeError(err)}`);
    return { ...DEFAULT_GATE_CONFIG };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`[GateConfig] Top-level value in ${SECUREFLOW_CONFIG_FILE} must be an object.`);
    return { ...DEFAULT_GATE_CONFIG };
  }

  const root = parsed as Record<string, unknown>;
  const rawGate = root.gate;

  if (
    rawGate !== undefined &&
    rawGate !== null &&
    (typeof rawGate !== "object" || Array.isArray(rawGate))
  ) {
    console.warn(`[GateConfig] 'gate' in ${SECUREFLOW_CONFIG_FILE} must be an object.`);
  }

  const gateObj =
    rawGate && typeof rawGate === "object" && !Array.isArray(rawGate)
      ? (rawGate as Record<string, unknown>)
      : {};

  // Support both blockOn and blockAt, reviewOn and reviewAt
  const rawBlock = gateObj.blockOn ?? gateObj.blockAt;
  const rawReview = gateObj.reviewOn ?? gateObj.reviewAt;

  let blockOn: GateLevel = DEFAULT_GATE_CONFIG.blockOn;
  if (rawBlock !== undefined) {
    const parsedBlock = parseGateLevel(rawBlock);
    if (parsedBlock !== null) {
      blockOn = parsedBlock;
    } else {
      console.warn(
        `[GateConfig] Unknown blockOn value '${String(rawBlock)}'; using default ${DEFAULT_GATE_CONFIG.blockOn}.`,
      );
    }
  }

  let reviewOn: GateLevel = DEFAULT_GATE_CONFIG.reviewOn;
  if (rawReview !== undefined) {
    const parsedReview = parseGateLevel(rawReview);
    if (parsedReview !== null) {
      reviewOn = parsedReview;
    } else {
      console.warn(
        `[GateConfig] Unknown reviewOn value '${String(rawReview)}'; using default ${DEFAULT_GATE_CONFIG.reviewOn}.`,
      );
    }
  }

  // Parse optional overrides (per finding type)
  const overrides: GateOverride[] = [];
  if (Array.isArray(gateObj.overrides)) {
    for (const ov of gateObj.overrides) {
      if (ov && typeof ov === "object" && typeof ov.type === "string" && ov.type.trim()) {
        const rawOvBlock = ov.blockOn ?? ov.blockAt;
        const rawOvReview = ov.reviewOn ?? ov.reviewAt;
        const ovBlock = rawOvBlock !== undefined ? parseGateLevel(rawOvBlock) : undefined;
        const ovReview = rawOvReview !== undefined ? parseGateLevel(rawOvReview) : undefined;

        overrides.push({
          type: ov.type.trim(),
          ...(ovBlock !== null && ovBlock !== undefined ? { blockOn: ovBlock } : {}),
          ...(ovReview !== null && ovReview !== undefined ? { reviewOn: ovReview } : {}),
        });
      }
    }
  }

  // #1557: only add `paths` when there is at least one valid rule, so a config
  // without paths parses exactly as before.
  const paths = parsePathRules(gateObj.paths);

  // #1868: parse optional policyScopes from root or gate object
  const rawPolicyScopes = root.policyScopes ?? gateObj.policyScopes;
  const { scopes: policyScopes } = parsePolicyScopes(rawPolicyScopes);

  // #1924: parse confidence settings from root.confidence, root, or gateObj
  const rawConfidenceObj =
    root.confidence && typeof root.confidence === "object" && !Array.isArray(root.confidence)
      ? (root.confidence as Record<string, unknown>)
      : undefined;

  const rawMinConfidence =
    rawConfidenceObj?.minCommentConfidence ??
    rawConfidenceObj?.minConfidence ??
    root.minCommentConfidence ??
    root.minConfidence ??
    gateObj.minCommentConfidence ??
    gateObj.minConfidence;

  let minCommentConfidence = DEFAULT_GATE_CONFIG.minCommentConfidence;
  if (rawMinConfidence !== undefined) {
    const parsedConf = parseConfidence(rawMinConfidence);
    if (parsedConf !== null) {
      minCommentConfidence = parsedConf;
    } else {
      console.warn(
        `[GateConfig] Unknown minCommentConfidence '${String(rawMinConfidence)}'; using default ${minCommentConfidence}.`,
      );
    }
  }

  const rawFilterBlocking =
    rawConfidenceObj?.filterBlocking ??
    rawConfidenceObj?.filterBlockingByConfidence ??
    root.filterBlocking ??
    gateObj.filterBlocking;
  const filterBlocking = typeof rawFilterBlocking === "boolean" ? rawFilterBlocking : false;

  // #1983: parse default ignore pattern overrides (includeDefaults, forceInclude)
  const rawIgnoreObj =
    root.ignore && typeof root.ignore === "object" && !Array.isArray(root.ignore)
      ? (root.ignore as Record<string, unknown>)
      : undefined;

  const rawScannerObj =
    root.scanner && typeof root.scanner === "object" && !Array.isArray(root.scanner)
      ? (root.scanner as Record<string, unknown>)
      : undefined;

  const rawIncludeDefaults =
    root.includeDefaults ??
    gateObj.includeDefaults ??
    rawIgnoreObj?.includeDefaults ??
    rawScannerObj?.includeDefaults;

  const includeDefaults = typeof rawIncludeDefaults === "boolean" ? rawIncludeDefaults : undefined;

  const rawForceInclude =
    root.forceInclude ??
    gateObj.forceInclude ??
    rawIgnoreObj?.forceInclude ??
    rawScannerObj?.forceInclude;

  const forceInclude: string[] = [];
  if (Array.isArray(rawForceInclude)) {
    for (const item of rawForceInclude) {
      if (typeof item === "string" && item.trim()) {
        forceInclude.push(item.trim());
      }
    }
  }

  // #1981: parse timeoutBudget and requestTimeout from root, scanner, or gate
  const rawTimeoutBudget =
    root.timeoutBudget ??
    root.timeoutBudgetSeconds ??
    rawScannerObj?.timeoutBudget ??
    rawScannerObj?.timeoutBudgetSeconds ??
    gateObj.timeoutBudget ??
    gateObj.timeoutBudgetSeconds;

  let timeoutBudget: number | undefined = undefined;
  if (rawTimeoutBudget !== undefined && rawTimeoutBudget !== null) {
    const num =
      typeof rawTimeoutBudget === "number"
        ? rawTimeoutBudget
        : Number(String(rawTimeoutBudget).trim());
    if (Number.isInteger(num) && num > 0) {
      timeoutBudget = num;
    } else {
      console.warn(
        `[GateConfig] Invalid timeoutBudget value '${String(rawTimeoutBudget)}' (expected positive integer in seconds); ignoring.`,
      );
    }
  }

  const rawRequestTimeout =
    root.requestTimeout ??
    root.requestTimeoutSeconds ??
    rawScannerObj?.requestTimeout ??
    rawScannerObj?.requestTimeoutSeconds ??
    gateObj.requestTimeout ??
    gateObj.requestTimeoutSeconds;

  let requestTimeout: number | undefined = undefined;
  if (rawRequestTimeout !== undefined && rawRequestTimeout !== null) {
    const num =
      typeof rawRequestTimeout === "number"
        ? rawRequestTimeout
        : Number(String(rawRequestTimeout).trim());
    if (Number.isInteger(num) && num > 0) {
      requestTimeout = num;
    } else {
      console.warn(
        `[GateConfig] Invalid requestTimeout value '${String(rawRequestTimeout)}' (expected positive integer in seconds); ignoring.`,
      );
    }
  }

  // #1982: parse skipDrafts and skipAuthors from root or gateObj
  const rawSkipDrafts = root.skipDrafts ?? gateObj.skipDrafts;
  let skipDrafts: boolean | undefined = undefined;
  if (rawSkipDrafts !== undefined) {
    if (typeof rawSkipDrafts === "boolean") {
      skipDrafts = rawSkipDrafts;
    } else {
      console.warn(
        `[GateConfig] Unknown skipDrafts value '${String(rawSkipDrafts)}' (expected boolean); ignoring.`,
      );
    }
  }

  const rawSkipAuthors = root.skipAuthors ?? gateObj.skipAuthors;
  let skipAuthors: string[] | undefined = undefined;
  if (rawSkipAuthors !== undefined) {
    if (Array.isArray(rawSkipAuthors)) {
      const parsedAuthors: string[] = [];
      for (const item of rawSkipAuthors) {
        if (typeof item === "string" && item.trim()) {
          parsedAuthors.push(item.trim());
        } else if (item !== undefined && item !== null) {
          console.warn(
            `[GateConfig] Invalid skipAuthors entry '${String(item)}' (expected string); ignoring.`,
          );
        }
      }
      if (parsedAuthors.length > 0) {
        skipAuthors = parsedAuthors;
      }
    } else {
      console.warn(
        `[GateConfig] Invalid skipAuthors value '${String(rawSkipAuthors)}' (expected array of strings); ignoring.`,
      );
    }
  }

  // #2006: parse contextLines from root, scanner, or gate
  const rawContextLines = root.contextLines ?? rawScannerObj?.contextLines ?? gateObj.contextLines;
  let contextLines: number | undefined = undefined;
  if (rawContextLines !== undefined && rawContextLines !== null) {
    const num =
      typeof rawContextLines === "number"
        ? rawContextLines
        : Number(String(rawContextLines).trim());
    if (Number.isInteger(num)) {
      if (num < MIN_CONTEXT_LINES) {
        console.warn(
          `[GateConfig] contextLines value ${num} is below minimum ${MIN_CONTEXT_LINES}; clamping to ${MIN_CONTEXT_LINES}.`,
        );
        contextLines = MIN_CONTEXT_LINES;
      } else if (num > MAX_CONTEXT_LINES) {
        console.warn(
          `[GateConfig] contextLines value ${num} exceeds maximum ${MAX_CONTEXT_LINES}; capping at ${MAX_CONTEXT_LINES}.`,
        );
        contextLines = MAX_CONTEXT_LINES;
      } else {
        contextLines = num;
      }
    } else {
      console.warn(
        `[GateConfig] Invalid contextLines value '${String(rawContextLines)}' (expected integer between ${MIN_CONTEXT_LINES} and ${MAX_CONTEXT_LINES}); ignoring.`,
      );
    }
  }

  // #2005: parse suggestions / suggestedChanges configuration (opt-in)
  const rawSuggestions =
    root.suggestions ?? root.suggestedChanges ?? gateObj.suggestions ?? gateObj.suggestedChanges;

  let suggestions:
    boolean | { enabled?: boolean; maxSuggestions?: number; limit?: number } | undefined =
    undefined;

  if (rawSuggestions !== undefined) {
    if (typeof rawSuggestions === "boolean") {
      suggestions = rawSuggestions;
    } else if (
      typeof rawSuggestions === "object" &&
      rawSuggestions !== null &&
      !Array.isArray(rawSuggestions)
    ) {
      suggestions = rawSuggestions as {
        enabled?: boolean;
        maxSuggestions?: number;
        limit?: number;
      };
    }
  }

  // #2004: parse rules and IaC configuration
  const rawRules = root.rules ?? gateObj.rules;
  const rawRulesObj =
    rawRules && typeof rawRules === "object" && !Array.isArray(rawRules)
      ? (rawRules as Record<string, unknown>)
      : undefined;

  let iacRulesEnabled: boolean | undefined = undefined;
  const rawIac = root.iac ?? gateObj.iac ?? rawRulesObj?.iac;
  if (rawIac === false) {
    iacRulesEnabled = false;
  } else if (typeof rawIac === "object" && rawIac !== null && !Array.isArray(rawIac)) {
    if ((rawIac as Record<string, unknown>).enabled === false) {
      iacRulesEnabled = false;
    }
  }

  const disabledRulesSet = new Set<string>();
  const collectRules = (arr: unknown) => {
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item === "string" && item.trim()) {
          disabledRulesSet.add(item.trim());
        }
      }
    }
  };

  collectRules(root.disabledRules);
  collectRules(gateObj.disabledRules);
  collectRules(rawRulesObj?.disabled);
  collectRules(rawRulesObj?.disabledRules);

  if (typeof rawIac === "object" && rawIac !== null && !Array.isArray(rawIac)) {
    collectRules((rawIac as Record<string, unknown>).disabled);
    collectRules((rawIac as Record<string, unknown>).disabledRules);
  }

  if (rawRulesObj) {
    for (const [key, val] of Object.entries(rawRulesObj)) {
      if (val === false && key !== "iac") {
        disabledRulesSet.add(key);
      }
    }
  }

  const disabledRules = disabledRulesSet.size > 0 ? Array.from(disabledRulesSet) : undefined;

  return {
    blockOn,
    reviewOn,
    overrides,
    ...(paths.length > 0 ? { paths } : {}),
    ...(policyScopes.length > 0 ? { policyScopes } : {}),
    minCommentConfidence,
    filterBlocking,
    ...(includeDefaults !== undefined ? { includeDefaults } : {}),
    ...(forceInclude.length > 0 ? { forceInclude } : {}),
    ...(timeoutBudget !== undefined ? { timeoutBudget, timeoutBudgetSeconds: timeoutBudget } : {}),
    ...(requestTimeout !== undefined
      ? { requestTimeout, requestTimeoutSeconds: requestTimeout }
      : {}),
    ...(skipDrafts !== undefined ? { skipDrafts } : {}),
    ...(skipAuthors && skipAuthors.length > 0 ? { skipAuthors } : {}),
    ...(contextLines !== undefined ? { contextLines } : {}),
    ...(suggestions !== undefined ? { suggestions } : {}),
    ...(iacRulesEnabled !== undefined ? { iacRulesEnabled } : {}),
    ...(disabledRules && disabledRules.length > 0 ? { disabledRules } : {}),
  };
}

/**
 * Resolves options for IaC security rules from repository gate configuration (#2004).
 */
export function resolveIacRuleOptions(config?: GateConfig | null): {
  enabled: boolean;
  disabledRules: string[];
} {
  if (!config) {
    return { enabled: true, disabledRules: [] };
  }
  return {
    enabled: config.iacRulesEnabled !== false,
    disabledRules: config.disabledRules ?? [],
  };
}

/**
 * Resolves suggestions configuration from gate config or root config (#2005).
 * Opt-in by default: returns { enabled: false, maxSuggestions: 5 } unless configured.
 */
export function resolveSuggestionsConfig(
  config?:
    | boolean
    | {
        enabled?: boolean;
        maxSuggestions?: number;
        limit?: number;
        suggestions?: boolean | { enabled?: boolean; maxSuggestions?: number; limit?: number };
        suggestedChanges?: boolean | { enabled?: boolean; maxSuggestions?: number; limit?: number };
      }
    | null,
): SuggestionsConfig {
  if (config === true) {
    return { enabled: true, maxSuggestions: DEFAULT_MAX_SUGGESTIONS };
  }
  if (!config || typeof config !== "object") {
    return { enabled: false, maxSuggestions: DEFAULT_MAX_SUGGESTIONS };
  }

  const raw = config.suggestions ?? config.suggestedChanges ?? config;
  if (raw === true) {
    return { enabled: true, maxSuggestions: DEFAULT_MAX_SUGGESTIONS };
  }
  if (typeof raw === "object" && raw !== null) {
    const rawObj = raw as { enabled?: boolean; maxSuggestions?: number; limit?: number };
    const enabled = rawObj.enabled === true;
    const rawMax = rawObj.maxSuggestions ?? rawObj.limit;
    const maxSuggestions =
      typeof rawMax === "number" && Number.isInteger(rawMax) && rawMax > 0
        ? rawMax
        : DEFAULT_MAX_SUGGESTIONS;
    return { enabled, maxSuggestions };
  }

  return { enabled: false, maxSuggestions: DEFAULT_MAX_SUGGESTIONS };
}

/**
 * Checks whether an author login matches the configured skipAuthors patterns (#1982).
 * Supports exact case-insensitive login matching and wildcard/glob patterns (e.g. 'dependabot[bot]', '*bot*').
 */
export function isAuthorSkipped(
  authorLogin?: string | null,
  skipAuthors?: string[] | null,
): boolean {
  if (!authorLogin || !skipAuthors || !Array.isArray(skipAuthors) || skipAuthors.length === 0) {
    return false;
  }

  const cleanAuthor = authorLogin.trim().toLowerCase();
  if (!cleanAuthor) return false;

  for (const pattern of skipAuthors) {
    if (typeof pattern !== "string") continue;
    const cleanPattern = pattern.trim().toLowerCase();
    if (!cleanPattern) continue;

    if (cleanPattern.includes("*") || cleanPattern.includes("?")) {
      const regexStr =
        "^" +
        cleanPattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".") +
        "$";
      try {
        const regex = new RegExp(regexStr, "i");
        if (regex.test(cleanAuthor)) return true;
      } catch {
        if (cleanAuthor === cleanPattern) return true;
      }
    } else {
      if (cleanAuthor === cleanPattern) return true;
    }
  }

  return false;
}

/**
 * Loads the gate configuration from `baseRef`.
 * Missing file (404) quietly resolves to defaults.
 * Any other error logs a warning and safely resolves to defaults.
 */
export async function loadBaseGateConfig(
  client: IgnoreConfigClient,
  args: { owner: string; repo: string; baseRef: string },
): Promise<GateConfig> {
  try {
    const { data } = await client.rest.repos.getContent({
      owner: args.owner,
      repo: args.repo,
      path: SECUREFLOW_CONFIG_FILE,
      ref: args.baseRef,
    });

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ...DEFAULT_GATE_CONFIG };
    }

    const { content } = data as { content?: unknown };
    if (typeof content !== "string") {
      return { ...DEFAULT_GATE_CONFIG };
    }

    const utf8 = Buffer.from(content, "base64").toString("utf8");
    return parseSecureFlowConfig(utf8);
  } catch (error) {
    if (!isNotFound(error)) {
      console.warn(
        `[GateConfig] Could not read ${SECUREFLOW_CONFIG_FILE} from ${args.owner}/${args.repo}@${args.baseRef}; using default gate: ${describeError(error)}`,
      );
    }
    return { ...DEFAULT_GATE_CONFIG };
  }
}

/**
 * Loads the trusted gate configuration for this pull request from its base branch.
 */
export async function loadTrustedGateConfig(
  client: IgnoreConfigClient,
  args: { owner: string; repo: string; prNumber: number; baseRef?: string | null },
): Promise<GateConfig> {
  const baseRef = args.baseRef || (await resolveBaseRef(client, args));

  if (!baseRef) {
    console.warn(
      `[GateConfig] No trusted ref for ${args.owner}/${args.repo}#${args.prNumber}; using default gate.`,
    );
    return { ...DEFAULT_GATE_CONFIG };
  }

  return loadBaseGateConfig(client, { owner: args.owner, repo: args.repo, baseRef });
}
