import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseFindingType } from "@/lib/finding-taxonomy";
import { isAtLeast } from "@/lib/severity";
import type { ScanFinding } from "../scanner";
import type { PromptRegressionSample, RecordedLlmResponse } from "./types";

export * from "./types";
export * from "./samples";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const RECORDED_RESPONSES_DIR = path.join(__dirname, "recorded-responses");

/**
 * Returns the absolute path to the recorded JSON response file for a sample ID.
 */
export function getRecordedResponsePath(sampleId: string): string {
  return path.join(RECORDED_RESPONSES_DIR, `${sampleId}.json`);
}

/**
 * Loads the recorded LLM response fixture for a given sample ID.
 */
export function getRecordedResponse(sampleId: string): RecordedLlmResponse {
  const filePath = getRecordedResponsePath(sampleId);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Recorded fixture response not found for sample ID '${sampleId}' at: ${filePath}`,
    );
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as RecordedLlmResponse;
}

/**
 * Writes or updates the recorded LLM response fixture for a given sample ID.
 */
export function saveRecordedResponse(sampleId: string, response: RecordedLlmResponse): void {
  if (!fs.existsSync(RECORDED_RESPONSES_DIR)) {
    fs.mkdirSync(RECORDED_RESPONSES_DIR, { recursive: true });
  }
  const filePath = getRecordedResponsePath(sampleId);
  fs.writeFileSync(filePath, JSON.stringify(response, null, 2) + "\n", "utf-8");
}

export interface SampleEvaluationResult {
  passed: boolean;
  detectedCount: number;
  expectedCategory?: string;
  actualCategories: string[];
  expectedMinSeverity?: string;
  actualSeverities: string[];
  reason: string;
}

/**
 * Validates actual scan findings against the sample's expected criteria.
 */
export function evaluateSampleMatch(
  sample: PromptRegressionSample,
  findings: ScanFinding[],
): SampleEvaluationResult {
  const detectedCount = findings.length;
  const actualCategories = findings.map((f) => parseFindingType(f.type) || "OTHER");
  const actualSeverities = findings.map((f) => f.severity);

  if (!sample.expected.shouldDetect) {
    if (detectedCount === 0) {
      return {
        passed: true,
        detectedCount: 0,
        actualCategories: [],
        actualSeverities: [],
        reason: "Negative sample correctly produced zero findings.",
      };
    }
    return {
      passed: false,
      detectedCount,
      actualCategories,
      actualSeverities,
      reason: `Expected zero findings for negative sample, but found ${detectedCount}.`,
    };
  }

  // Positive sample checks
  if (detectedCount === 0) {
    return {
      passed: false,
      detectedCount: 0,
      expectedCategory: sample.expected.category,
      actualCategories: [],
      expectedMinSeverity: sample.expected.minSeverity,
      actualSeverities: [],
      reason: `Expected positive detection of ${sample.expected.category ?? "finding"} (${sample.expected.minSeverity ?? "any"}), but found 0 findings.`,
    };
  }

  // Category check if specified
  if (sample.expected.category) {
    const categoryMatches = actualCategories.includes(sample.expected.category);
    if (!categoryMatches) {
      return {
        passed: false,
        detectedCount,
        expectedCategory: sample.expected.category,
        actualCategories,
        expectedMinSeverity: sample.expected.minSeverity,
        actualSeverities,
        reason: `Expected category ${sample.expected.category}, but received [${actualCategories.join(", ")}].`,
      };
    }
  }

  // Severity check if specified
  if (sample.expected.minSeverity) {
    const minSev = sample.expected.minSeverity;
    const meetsSeverity = findings.some((f) => {
      // If category is specified, only check severities of findings in that category
      if (sample.expected.category && parseFindingType(f.type) !== sample.expected.category) {
        return false;
      }
      return isAtLeast(f.severity, minSev);
    });

    if (!meetsSeverity) {
      return {
        passed: false,
        detectedCount,
        expectedCategory: sample.expected.category,
        actualCategories,
        expectedMinSeverity: minSev,
        actualSeverities,
        reason: `No finding met minimum severity ${minSev}. Actual severities: [${actualSeverities.join(", ")}].`,
      };
    }
  }

  return {
    passed: true,
    detectedCount,
    expectedCategory: sample.expected.category,
    actualCategories,
    expectedMinSeverity: sample.expected.minSeverity,
    actualSeverities,
    reason: `Finding detected matching category ${sample.expected.category ?? "*"} and severity >= ${sample.expected.minSeverity ?? "*"}.`,
  };
}
