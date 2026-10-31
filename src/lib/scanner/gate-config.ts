/**
 * Configuration for the server-side PR policy gate.
 *
 * maintainers can configure the gate with `.secureflowjson` at the repository root,
 * read from the PR's base branch (never from the head branch).
 *
 * Implements Issue #1491 & #1470.
 */

import { z } from "zod";
import { parseSeverity, type Severity } from "@/lib/severity";
import type { IgnoreConfigClient } from "./ignore-config";
import { resolveBaseRef } from "./ignore-config";

export const SECUREFLOW_CONFIG_FILE = ".secureflow.json";

/** Gate threshold level including NONE (which turns that gate level off). */
export type GateLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "NONE";

/** Type-specific override configuration. */
export interface GateOverride {
  type: string;
  blockOn?: GateLevel;
  reviewOn?: GateLevel;
}

export interface GateConfig {
  blockOn: GateLevel;
  reviewOn: GateLevel;
  overrides?: GateOverride[];
}

export interface SecureFlowConfig {
  gate: GateConfig;
}

/** Default gate thresholds when no config exists or on bad configuration. */
export const DEFAULT_GATE_CONFIG: Readonly<GateConfig> = {
  blockOn: "CRITICAL",
  reviewOn: "MEDIUM",
  overrides: [],
};

const GATE_LEVEL_VALUES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "NONE"] as const;

/** Helper to parse a GateLevel string case-insensitively. */
export function parseGateLevel(value: unknown): GateLevel | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  if (upper === "NONE") return "NONE";
  const parsed = parseSeverity(upper);
  if (parsed === "CRITICAL" || parsed === "HIGH" || parsed === "MEDIUM" || parsed === "LOW" || parsed === "NONE") {
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
  return sameBlock && sameReview && noOverrides;
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
 * Parses raw JSON string into a validated GateConfig with safe fallbacks.
 * A malformed file, invalid JSON, or wrong type logs a warning and returns DEFAULT_GATE_CONFIG.
 * An unknown value for one key uses the default for that key only and logs a warning.
 */
export function parseSecureFlowConfig(rawJson: string): GateConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
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

  if (rawGate === undefined || rawGate === null) {
    return { ...DEFAULT_GATE_CONFIG };
  }

  if (typeof rawGate !== "object" || Array.isArray(rawGate)) {
    console.warn(`[GateConfig] 'gate' in ${SECUREFLOW_CONFIG_FILE} must be an object.`);
    return { ...DEFAULT_GATE_CONFIG };
  }

  const gateObj = rawGate as Record<string, unknown>;

  // Support both blockOn and blockAt, reviewOn and reviewAt
  const rawBlock = gateObj.blockOn ?? gateObj.blockAt;
  const rawReview = gateObj.reviewOn ?? gateObj.reviewAt;

  let blockOn: GateLevel = DEFAULT_GATE_CONFIG.blockOn;
  if (rawBlock !== undefined) {
    const parsedBlock = parseGateLevel(rawBlock);
    if (parsedBlock !== null) {
      blockOn = parsedBlock;
    } else {
      console.warn(`[GateConfig] Unknown blockOn value '${String(rawBlock)}'; using default ${DEFAULT_GATE_CONFIG.blockOn}.`);
    }
  }

  let reviewOn: GateLevel = DEFAULT_GATE_CONFIG.reviewOn;
  if (rawReview !== undefined) {
    const parsedReview = parseGateLevel(rawReview);
    if (parsedReview !== null) {
      reviewOn = parsedReview;
    } else {
      console.warn(`[GateConfig] Unknown reviewOn value '${String(rawReview)}'; using default ${DEFAULT_GATE_CONFIG.reviewOn}.`);
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

  return {
    blockOn,
    reviewOn,
    overrides,
  };
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
