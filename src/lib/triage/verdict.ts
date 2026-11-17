import { iq } from "@/lib/armor/iq";
import type { ScanFinding } from "@/lib/armor/scanner";
import { normalizeSeverity, totalRiskScore } from "@/lib/severity";
import { DEFAULT_GATE_CONFIG, type GateConfig } from "@/lib/scanner/gate-config";

export interface StoredTriageFinding {
  fingerprint: string;
  type: string;
  severity: string;
  fileLocation: string;
  codeSnippet: string | null;
  explanation: string | null;
  lineStart: number | null;
  lineEnd: number | null;
}

/** Re-evaluate the latest saved scan without re-running the scanner or AI. */
export function triagedVerdict(
  findings: readonly StoredTriageFinding[],
  suppressedFingerprints: ReadonlySet<string>,
  gate: GateConfig = DEFAULT_GATE_CONFIG,
) {
  const active = findings
    .filter((finding) => !suppressedFingerprints.has(finding.fingerprint))
    .map((finding): ScanFinding => ({
      type: finding.type,
      severity: normalizeSeverity(finding.severity),
      description: finding.explanation ?? "",
      fileLocation: finding.fileLocation,
      codeSnippet: finding.codeSnippet ?? "",
      ...(finding.lineStart !== null ? { lineStart: finding.lineStart } : {}),
      ...(finding.lineEnd !== null ? { lineEnd: finding.lineEnd } : {}),
    }));

  return {
    decision: iq.evaluateFindings(active, gate),
    riskScore: Math.round(totalRiskScore(active)),
    active,
  };
}
