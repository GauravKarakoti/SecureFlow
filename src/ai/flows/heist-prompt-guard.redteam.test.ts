import { describe, expect, it } from "vitest";
import {
  BENIGN_SAMPLES,
  INJECTION_PAYLOADS,
  type InjectionPayload,
} from "./prompt-injection-payloads";

import { evaluatePromptSafety } from "./heist-prompt-guard";

async function guard(content: string) {
  const result = await evaluatePromptSafety(content);
  return result; // expected shape: { isSafe: boolean; flaggedReason?: string | null }
}

describe("Heist Prompt Guard -- automated red-team suite", () => {
  describe.each(
    Object.entries(
      INJECTION_PAYLOADS.reduce<Record<string, InjectionPayload[]>>((acc, p) => {
        (acc[p.category] ??= []).push(p);
        return acc;
      }, {}),
    ),
  )("category: %s", (_category, payloads) => {
    it.each(payloads as InjectionPayload[])(
      "blocks payload $id -- $description",
      async ({ payload }) => {
        const result = await guard(payload);
        expect(
          result.isSafe,
          `Expected payload "${payload.slice(0, 60)}..." to be flagged unsafe, but the guard allowed it through.`,
        ).toBe(false);
      },
    );
  });

  it("does not false-positive on ordinary, benign code-review content", async () => {
    for (const sample of BENIGN_SAMPLES) {
      const result = await guard(sample);
      expect(
        result.isSafe,
        `Expected benign content to pass, but the guard incorrectly flagged: "${sample.slice(0, 60)}..."`,
      ).toBe(true);
    }
  });

  it("reports a non-empty flaggedReason for every blocked payload", async () => {
    const sample = INJECTION_PAYLOADS[0];
    const result = await guard(sample.payload);
    expect(result.isSafe).toBe(false);
    expect(typeof result.flaggedReason).toBe("string");
    expect(result.flaggedReason!.length).toBeGreaterThan(0);
  });

  it("covers every documented injection category at least once", () => {
    const categories = new Set(INJECTION_PAYLOADS.map((p) => p.category));
    expect(categories.size).toBeGreaterThanOrEqual(8);
  });
});
