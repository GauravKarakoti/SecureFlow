/**
 * CVSS v3.x base scores from vector strings.
 *
 * OSV reports an advisory's severity as a CVSS vector in `severity[]`
 * (`{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/..." }`). A ready-made label in
 * `database_specific.severity` is source-specific (GitHub-reviewed advisories
 * have one); records from other sources, such as the PyPA advisory database
 * (`PYSEC-*`), usually reach us with nothing but the vector.
 * Scoring it here turns those into the same CRITICAL/HIGH/MEDIUM/LOW scale as
 * the rest of the pipeline instead of defaulting them all to MEDIUM.
 *
 * Implements the base-score equations of the CVSS v3.1 specification, section
 * 7.1, including its `Roundup` definition (7.4). v3.0 vectors share the same
 * metrics and weights and are scored the same way.
 *
 * @see https://www.first.org/cvss/v3.1/specification-document
 */

import type { SeverityLevel } from "@/types/sbom";

const ATTACK_VECTOR: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const ATTACK_COMPLEXITY: Record<string, number> = { L: 0.77, H: 0.44 };
const USER_INTERACTION: Record<string, number> = { N: 0.85, R: 0.62 };
const IMPACT: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };
/** Privileges Required depends on Scope: its weight rises when scope changes. */
const PRIVILEGES_REQUIRED: Record<"U" | "C", Record<string, number>> = {
  U: { N: 0.85, L: 0.62, H: 0.27 },
  C: { N: 0.85, L: 0.68, H: 0.5 },
};

const REQUIRED_METRICS = ["AV", "AC", "PR", "UI", "S", "C", "I", "A"] as const;

/**
 * The specification's Roundup: the smallest number, to one decimal place, that
 * is equal to or higher than its input. Done in integer arithmetic so that
 * floating-point noise (e.g. 4.000000001) does not push a score up a tenth.
 */
export function roundUp(value: number): number {
  const intInput = Math.round(value * 100_000);
  if (intInput % 10_000 === 0) return intInput / 100_000;
  return (Math.floor(intInput / 10_000) + 1) / 10;
}

/**
 * Base score (0.0–10.0) of a CVSS v3.0/v3.1 vector, or `null` when the string is
 * not a complete, valid v3 vector.
 */
export function cvss3BaseScore(vector: string): number | null {
  const parts = vector.trim().split("/");
  const prefix = parts.shift();
  if (prefix !== "CVSS:3.0" && prefix !== "CVSS:3.1") return null;

  const metrics = new Map<string, string>();
  for (const part of parts) {
    const [key, value] = part.split(":");
    if (!key || !value || metrics.has(key)) return null;
    metrics.set(key, value);
  }

  if (REQUIRED_METRICS.some((key) => !metrics.has(key))) return null;

  const scope = metrics.get("S");
  if (scope !== "U" && scope !== "C") return null;

  const av = ATTACK_VECTOR[metrics.get("AV")!];
  const ac = ATTACK_COMPLEXITY[metrics.get("AC")!];
  const pr = PRIVILEGES_REQUIRED[scope][metrics.get("PR")!];
  const ui = USER_INTERACTION[metrics.get("UI")!];
  const c = IMPACT[metrics.get("C")!];
  const i = IMPACT[metrics.get("I")!];
  const a = IMPACT[metrics.get("A")!];

  if ([av, ac, pr, ui, c, i, a].some((weight) => weight === undefined)) return null;

  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!);
  const impact =
    scope === "U" ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  if (impact <= 0) return 0;

  const exploitability = 8.22 * av! * ac! * pr! * ui!;
  return scope === "U"
    ? roundUp(Math.min(impact + exploitability, 10))
    : roundUp(Math.min(1.08 * (impact + exploitability), 10));
}

/**
 * Qualitative rating for a base score (specification, section 5).
 *
 * The pipeline has no NONE level, so a 0.0 score (no confidentiality,
 * integrity or availability impact) is reported as LOW rather than dropped.
 */
export function cvssSeverity(score: number): SeverityLevel {
  if (score >= 9) return "CRITICAL";
  if (score >= 7) return "HIGH";
  if (score >= 4) return "MEDIUM";
  return "LOW";
}

/**
 * The severity of the highest-scoring CVSS v3 vector among OSV `severity`
 * entries, or `null` when none of them is a v3 vector that can be scored.
 *
 * v2 and v4 entries are skipped (v4 scoring needs the specification's lookup
 * tables); an advisory with only those keeps the caller's fallback.
 */
export function severityFromCvssEntries(
  entries: ReadonlyArray<{ type?: string; score?: string }> | undefined,
): SeverityLevel | null {
  let best: number | null = null;

  for (const entry of entries ?? []) {
    if (entry?.type !== "CVSS_V3" || typeof entry.score !== "string") continue;
    const score = cvss3BaseScore(entry.score);
    if (score !== null && (best === null || score > best)) best = score;
  }

  return best === null ? null : cvssSeverity(best);
}
