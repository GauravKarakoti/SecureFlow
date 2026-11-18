import type { FindingCategory } from "@/lib/finding-taxonomy";
import type { Severity } from "@/lib/severity";
import type { ScannerPolicy } from "../scanner";

export interface ExpectedFinding {
  /**
   * Whether the scanner should flag any security findings for this sample.
   * `true` for positive samples (vulnerabilities, secrets, misconfigurations);
   * `false` for negative samples (safe code, placeholders, sanitized queries).
   */
  shouldDetect: boolean;

  /**
   * The expected finding taxonomy category (e.g., "SECRET", "VULNERABILITY", "MISCONFIG").
   */
  category?: FindingCategory | "SECRET" | "VULNERABILITY" | "MISCONFIG";

  /**
   * The minimum expected severity level (e.g., "CRITICAL", "HIGH", "MEDIUM").
   */
  minSeverity?: Severity;

  /**
   * Optional substring or keyword expected in the finding description or code snippet.
   */
  descriptionSnippet?: string;
}

export interface PromptRegressionSample {
  /** Unique kebab-case identifier, e.g. "hardcoded-secret" */
  id: string;
  /** Human-readable title */
  name: string;
  /** Detailed description of what the snippet contains and why it should/should not be flagged */
  filename: string;
  /** Raw source code of the snippet */
  code: string;
  /** Unified diff patch string simulating PR change */
  patch: string;
  /** Expected detection behavior */
  expected: ExpectedFinding;
  /** Configured policies for the scan (optional, defaults to regression policies) */
  policies?: ScannerPolicy[];
}

export interface LlmFindingFixture {
  reasoning?: string;
  type: string;
  severity: string;
  description: string;
  fileLocation: string;
  codeSnippet: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface RecordedLlmResponse {
  findings: LlmFindingFixture[];
}
