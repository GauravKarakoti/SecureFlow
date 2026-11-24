/**
 * Installation Settings & Hierarchical Configuration Resolution Engine (#2010)
 *
 * Resolves effective security configuration across three layers:
 *   1. Built-in system defaults (lowest precedence)
 *   2. Installation-level baseline defaults
 *   3. Repository .secureflow.json (highest precedence, unless setting is locked)
 *
 * When an admin locks specific settings (e.g. 'gateBlockOn', 'minCommentConfidence', 'includeDefaults'),
 * repository .secureflow.json configurations are prevented from weakening the baseline.
 *
 * Tracks the effective value, its originating source ("built-in", "installation", or "repository"),
 * and whether the setting is locked.
 */

import {
  type GateConfig,
  type GateLevel,
  DEFAULT_GATE_CONFIG,
  parseGateLevel,
  isAuthorSkipped,
} from "./gate-config";
import {
  type ConfidenceLevel,
  DEFAULT_MIN_COMMENT_CONFIDENCE,
  parseConfidence,
  confidenceRank,
} from "@/lib/confidence";
import { severityRank } from "@/lib/severity";

export type SettingSource = "built-in" | "installation" | "repository";

export interface SettingValueWithSource<T> {
  value: T;
  source: SettingSource;
  isLocked: boolean;
}

export interface InstallationSettingsDto {
  installationId?: string;
  gateBlockOn?: GateLevel | null;
  gateReviewOn?: GateLevel | null;
  minCommentConfidence?: ConfidenceLevel | null;
  includeDefaults?: boolean | null;
  skipDrafts?: boolean | null;
  skipAuthors?: string[] | null;
  lockedSettings?: string[];
}

export interface EffectiveResolvedSettings {
  gateBlockOn: SettingValueWithSource<GateLevel>;
  gateReviewOn: SettingValueWithSource<GateLevel>;
  minCommentConfidence: SettingValueWithSource<ConfidenceLevel>;
  includeDefaults: SettingValueWithSource<boolean>;
  skipDrafts: SettingValueWithSource<boolean>;
  skipAuthors: SettingValueWithSource<string[]>;
}

export const LOCKABLE_SETTING_KEYS = [
  "gateBlockOn",
  "gateReviewOn",
  "minCommentConfidence",
  "includeDefaults",
  "skipDrafts",
  "skipAuthors",
] as const;

export type LockableSettingKey = (typeof LOCKABLE_SETTING_KEYS)[number];

/**
 * Checks if a proposed repository severity weakens a locked baseline threshold.
 * For gate levels: CRITICAL(0) > HIGH(1) > MEDIUM(2) > LOW(3) > NONE(4).
 * A repository setting weakens the baseline if its severity rank is higher (less strict/severe)
 * than the locked baseline rank.
 */
export function isSeverityWeaker(candidate: GateLevel, baseline: GateLevel): boolean {
  // severityRank returns lower number for more severe level (e.g. CRITICAL=0, HIGH=1, NONE=4)
  const candidateRank = severityRank(candidate);
  const baselineRank = severityRank(baseline);
  return candidateRank > baselineRank;
}

/**
 * Checks if a proposed repository confidence threshold weakens a locked baseline.
 * Confidence ranks: HIGH(3) > MEDIUM(2) > LOW(1).
 * Weakening occurs if candidate rank is lower than baseline.
 */
export function isConfidenceWeaker(candidate: ConfidenceLevel, baseline: ConfidenceLevel): boolean {
  return confidenceRank(candidate) < confidenceRank(baseline);
}

/**
 * Resolves effective settings across Built-in, Installation, and Repository layers.
 */
export function resolveEffectiveSettings(
  repoConfig?: Partial<GateConfig> | null,
  installationSettings?: InstallationSettingsDto | null,
): EffectiveResolvedSettings {
  const lockedKeys = new Set(installationSettings?.lockedSettings || []);

  // 1. gateBlockOn
  let gateBlockOn: SettingValueWithSource<GateLevel>;
  const instBlockOn = installationSettings?.gateBlockOn
    ? parseGateLevel(installationSettings.gateBlockOn)
    : null;
  const repoBlockOn = repoConfig?.blockOn ? parseGateLevel(repoConfig.blockOn) : null;
  const isBlockOnLocked = lockedKeys.has("gateBlockOn") && instBlockOn !== null;

  if (isBlockOnLocked) {
    // If locked, repository cannot weaken baseline
    if (repoBlockOn !== null && !isSeverityWeaker(repoBlockOn, instBlockOn)) {
      gateBlockOn = { value: repoBlockOn, source: "repository", isLocked: true };
    } else {
      gateBlockOn = { value: instBlockOn, source: "installation", isLocked: true };
    }
  } else if (repoBlockOn !== null) {
    gateBlockOn = { value: repoBlockOn, source: "repository", isLocked: false };
  } else if (instBlockOn !== null) {
    gateBlockOn = { value: instBlockOn, source: "installation", isLocked: false };
  } else {
    gateBlockOn = {
      value: DEFAULT_GATE_CONFIG.blockOn,
      source: "built-in",
      isLocked: false,
    };
  }

  // 2. gateReviewOn
  let gateReviewOn: SettingValueWithSource<GateLevel>;
  const instReviewOn = installationSettings?.gateReviewOn
    ? parseGateLevel(installationSettings.gateReviewOn)
    : null;
  const repoReviewOn = repoConfig?.reviewOn ? parseGateLevel(repoConfig.reviewOn) : null;
  const isReviewOnLocked = lockedKeys.has("gateReviewOn") && instReviewOn !== null;

  if (isReviewOnLocked) {
    if (repoReviewOn !== null && !isSeverityWeaker(repoReviewOn, instReviewOn)) {
      gateReviewOn = { value: repoReviewOn, source: "repository", isLocked: true };
    } else {
      gateReviewOn = { value: instReviewOn, source: "installation", isLocked: true };
    }
  } else if (repoReviewOn !== null) {
    gateReviewOn = { value: repoReviewOn, source: "repository", isLocked: false };
  } else if (instReviewOn !== null) {
    gateReviewOn = { value: instReviewOn, source: "installation", isLocked: false };
  } else {
    gateReviewOn = {
      value: DEFAULT_GATE_CONFIG.reviewOn,
      source: "built-in",
      isLocked: false,
    };
  }

  // 3. minCommentConfidence
  let minCommentConfidence: SettingValueWithSource<ConfidenceLevel>;
  const instMinConfidence = installationSettings?.minCommentConfidence
    ? parseConfidence(installationSettings.minCommentConfidence)
    : null;
  const repoMinConfidence = repoConfig?.minCommentConfidence
    ? parseConfidence(repoConfig.minCommentConfidence)
    : null;
  const isConfidenceLocked = lockedKeys.has("minCommentConfidence") && instMinConfidence !== null;

  if (isConfidenceLocked) {
    if (repoMinConfidence !== null && !isConfidenceWeaker(repoMinConfidence, instMinConfidence)) {
      minCommentConfidence = {
        value: repoMinConfidence,
        source: "repository",
        isLocked: true,
      };
    } else {
      minCommentConfidence = {
        value: instMinConfidence,
        source: "installation",
        isLocked: true,
      };
    }
  } else if (repoMinConfidence !== null) {
    minCommentConfidence = {
      value: repoMinConfidence,
      source: "repository",
      isLocked: false,
    };
  } else if (instMinConfidence !== null) {
    minCommentConfidence = {
      value: instMinConfidence,
      source: "installation",
      isLocked: false,
    };
  } else {
    minCommentConfidence = {
      value: DEFAULT_MIN_COMMENT_CONFIDENCE,
      source: "built-in",
      isLocked: false,
    };
  }

  // 4. includeDefaults (default ignore patterns)
  let includeDefaults: SettingValueWithSource<boolean>;
  const isIncludeDefaultsLocked = lockedKeys.has("includeDefaults");
  const instIncludeDefaults =
    typeof installationSettings?.includeDefaults === "boolean"
      ? installationSettings.includeDefaults
      : null;
  const repoIncludeDefaults =
    typeof repoConfig?.includeDefaults === "boolean" ? repoConfig.includeDefaults : null;

  if (isIncludeDefaultsLocked && instIncludeDefaults !== null) {
    includeDefaults = {
      value: instIncludeDefaults,
      source: "installation",
      isLocked: true,
    };
  } else if (repoIncludeDefaults !== null) {
    includeDefaults = {
      value: repoIncludeDefaults,
      source: "repository",
      isLocked: false,
    };
  } else if (instIncludeDefaults !== null) {
    includeDefaults = {
      value: instIncludeDefaults,
      source: "installation",
      isLocked: false,
    };
  } else {
    includeDefaults = {
      value: true,
      source: "built-in",
      isLocked: false,
    };
  }

  // 5. skipDrafts
  let skipDrafts: SettingValueWithSource<boolean>;
  const isSkipDraftsLocked = lockedKeys.has("skipDrafts");
  const instSkipDrafts =
    typeof installationSettings?.skipDrafts === "boolean" ? installationSettings.skipDrafts : null;
  const repoSkipDrafts = typeof repoConfig?.skipDrafts === "boolean" ? repoConfig.skipDrafts : null;

  if (isSkipDraftsLocked && instSkipDrafts !== null) {
    skipDrafts = {
      value: instSkipDrafts,
      source: "installation",
      isLocked: true,
    };
  } else if (repoSkipDrafts !== null) {
    skipDrafts = {
      value: repoSkipDrafts,
      source: "repository",
      isLocked: false,
    };
  } else if (instSkipDrafts !== null) {
    skipDrafts = {
      value: instSkipDrafts,
      source: "installation",
      isLocked: false,
    };
  } else {
    skipDrafts = {
      value: false,
      source: "built-in",
      isLocked: false,
    };
  }

  // 6. skipAuthors
  let skipAuthors: SettingValueWithSource<string[]>;
  const isSkipAuthorsLocked = lockedKeys.has("skipAuthors");
  const instSkipAuthors =
    Array.isArray(installationSettings?.skipAuthors) && installationSettings.skipAuthors.length > 0
      ? installationSettings.skipAuthors
      : null;
  const repoSkipAuthors =
    Array.isArray(repoConfig?.skipAuthors) && repoConfig.skipAuthors.length > 0
      ? repoConfig.skipAuthors
      : null;

  if (isSkipAuthorsLocked && instSkipAuthors !== null) {
    skipAuthors = {
      value: instSkipAuthors,
      source: "installation",
      isLocked: true,
    };
  } else if (repoSkipAuthors !== null) {
    skipAuthors = {
      value: repoSkipAuthors,
      source: "repository",
      isLocked: false,
    };
  } else if (instSkipAuthors !== null) {
    skipAuthors = {
      value: instSkipAuthors,
      source: "installation",
      isLocked: false,
    };
  } else {
    skipAuthors = {
      value: [],
      source: "built-in",
      isLocked: false,
    };
  }

  return {
    gateBlockOn,
    gateReviewOn,
    minCommentConfidence,
    includeDefaults,
    skipDrafts,
    skipAuthors,
  };
}

/**
 * Builds an effective GateConfig for scanEngine by merging resolved settings with
 * any repository-specific non-locked properties (e.g. overrides, paths, policyScopes).
 */
export function buildEffectiveGateConfig(
  repoConfig?: GateConfig | null,
  installationSettings?: InstallationSettingsDto | null,
): GateConfig {
  const resolved = resolveEffectiveSettings(repoConfig, installationSettings);

  return {
    ...DEFAULT_GATE_CONFIG,
    ...repoConfig,
    blockOn: resolved.gateBlockOn.value,
    reviewOn: resolved.gateReviewOn.value,
    minCommentConfidence: resolved.minCommentConfidence.value,
    includeDefaults: resolved.includeDefaults.value,
    skipDrafts: resolved.skipDrafts.value,
    skipAuthors: resolved.skipAuthors.value,
  };
}
