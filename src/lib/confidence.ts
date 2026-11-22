/**
 * Single source of truth for confidence levels in SecureFlow (#1924).
 *
 * The scanner assigns a confidence score to each finding:
 * - HIGH: Definite, active vulnerability or high-entropy production credential.
 * - MEDIUM: Standard, probable vulnerability or credential (safe default).
 * - LOW: Uncertain pattern, plausible placeholder, or test fixture.
 */

export const CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const DEFAULT_CONFIDENCE: ConfidenceLevel = "MEDIUM";

export const DEFAULT_MIN_COMMENT_CONFIDENCE: ConfidenceLevel = "MEDIUM";

const CONFIDENCE_RANKS: Record<ConfidenceLevel, number> = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

const CANONICAL_CONFIDENCE = new Set<string>(CONFIDENCE_LEVELS);

const CONFIDENCE_ALIASES: Record<string, ConfidenceLevel> = {
  HIGH: "HIGH",
  HI: "HIGH",
  MEDIUM: "MEDIUM",
  MED: "MEDIUM",
  MODERATE: "MEDIUM",
  LOW: "LOW",
  LO: "LOW",
};

/**
 * Parses a confidence value case-insensitively, returning null if uninterpretable.
 */
export function parseConfidence(value: unknown): ConfidenceLevel | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (CANONICAL_CONFIDENCE.has(normalized)) {
    return normalized as ConfidenceLevel;
  }
  return CONFIDENCE_ALIASES[normalized] ?? null;
}

/**
 * Normalizes an unknown confidence value, falling back safely to DEFAULT_CONFIDENCE (MEDIUM).
 */
export function normalizeConfidence(
  value: unknown,
  fallback: ConfidenceLevel = DEFAULT_CONFIDENCE,
): ConfidenceLevel {
  return parseConfidence(value) ?? fallback;
}

/**
 * Returns numeric rank for confidence comparison (HIGH=3, MEDIUM=2, LOW=1).
 */
export function confidenceRank(confidence: ConfidenceLevel): number {
  return CONFIDENCE_RANKS[confidence] ?? CONFIDENCE_RANKS[DEFAULT_CONFIDENCE];
}

/**
 * Checks if a finding's confidence meets or exceeds a target threshold.
 */
export function isConfidenceAtLeast(
  findingConfidence: unknown,
  threshold: ConfidenceLevel,
): boolean {
  const normConfidence = normalizeConfidence(findingConfidence);
  return confidenceRank(normConfidence) >= confidenceRank(threshold);
}

/**
 * Filters a list of findings by minimum confidence threshold.
 */
export function filterFindingsByConfidence<T extends { confidence?: string }>(
  findings: readonly T[],
  minConfidence: ConfidenceLevel,
): { visible: T[]; hiddenCount: number } {
  const visible: T[] = [];
  let hiddenCount = 0;

  for (const f of findings) {
    if (isConfidenceAtLeast(f.confidence, minConfidence)) {
      visible.push(f);
    } else {
      hiddenCount++;
    }
  }

  return { visible, hiddenCount };
}
