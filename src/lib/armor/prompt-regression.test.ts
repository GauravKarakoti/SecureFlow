import { beforeEach, describe, expect, it } from "vitest";
import { mockCreate } from "../../../__mocks__/groq-sdk";
import { ArmorIQScanner } from "./scanner";
import {
  PROMPT_REGRESSION_SAMPLES,
  getRecordedResponse,
  evaluateSampleMatch,
  type PromptRegressionSample,
} from "./__fixtures__";
import { parseFindingType } from "@/lib/finding-taxonomy";
import { isAtLeast } from "@/lib/severity";

describe("Prompt Regression Golden-File Test Suite (#1807)", () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  it("includes at least 10 regression samples (including positives and negatives)", () => {
    expect(PROMPT_REGRESSION_SAMPLES.length).toBeGreaterThanOrEqual(10);

    const positives = PROMPT_REGRESSION_SAMPLES.filter((s) => s.expected.shouldDetect);
    const negatives = PROMPT_REGRESSION_SAMPLES.filter((s) => !s.expected.shouldDetect);

    expect(positives.length).toBeGreaterThanOrEqual(5);
    expect(negatives.length).toBeGreaterThanOrEqual(3);
  });

  it("has valid, loadable JSON recorded fixtures for every sample", () => {
    for (const sample of PROMPT_REGRESSION_SAMPLES) {
      const fixture = getRecordedResponse(sample.id);
      expect(fixture).toBeDefined();
      expect(Array.isArray(fixture.findings)).toBe(true);

      if (sample.expected.shouldDetect) {
        expect(fixture.findings.length).toBeGreaterThan(0);
      } else {
        expect(fixture.findings.length).toBe(0);
      }
    }
  });

  describe.each(PROMPT_REGRESSION_SAMPLES)(
    "Sample: $id ($name)",
    (sample: PromptRegressionSample) => {
      it(`evaluates ${sample.expected.shouldDetect ? "positive detection" : "negative non-detection"} correctly via scanner with mocked Groq`, async () => {
        const fixture = getRecordedResponse(sample.id);

        mockCreate.mockResolvedValueOnce({
          choices: [
            {
              message: {
                content: JSON.stringify(fixture),
              },
            },
          ],
        });

        const scanner = new ArmorIQScanner();
        const findings = await scanner.scanPullRequest(
          [{ filename: sample.filename, patch: sample.patch }],
          sample.policies,
        );

        const evalResult = evaluateSampleMatch(sample, findings);
        expect(evalResult.passed, evalResult.reason).toBe(true);

        if (sample.expected.shouldDetect) {
          expect(findings.length).toBeGreaterThan(0);

          if (sample.expected.category) {
            const categories = findings.map((f) => parseFindingType(f.type));
            expect(categories).toContain(sample.expected.category);
          }

          if (sample.expected.minSeverity) {
            const matching = findings.filter(
              (f) =>
                !sample.expected.category || parseFindingType(f.type) === sample.expected.category,
            );
            const hasSufficientSeverity = matching.some((f) =>
              isAtLeast(f.severity, sample.expected.minSeverity!),
            );
            expect(hasSufficientSeverity).toBe(true);
          }
        } else {
          expect(findings).toHaveLength(0);
        }
      });
    },
  );
});
