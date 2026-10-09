import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGenerate = vi.fn();

vi.mock("@/ai/genkit", () => ({
  getAiInstance: vi.fn(() => ({ generate: mockGenerate })),
  getDefaultModelRef: vi.fn(() => "mock-model"),
}));

import { getAiInstance, getDefaultModelRef } from "@/ai/genkit";
import {
  generateRemediationPatch,
  generateRemediationPatchFlow,
} from "./generate-remediation-patch";

const VALID_INPUT = {
  vulnerableCode: "const query = 'SELECT * FROM users WHERE id = ' + userId;",
  findingDescription: "SQL injection via string concatenation",
  filePath: "src/db.ts",
};

const MOCK_OUTPUT = {
  patchDiff:
    "--- a/src/db.ts\n+++ b/src/db.ts\n@@ -1 +1 @@\n-const query = ...\n+const query = ...",
  explanation: "Replaced string concatenation with a parameterized query.",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerate.mockResolvedValue({ output: MOCK_OUTPUT });
});

describe("generateRemediationPatch", () => {
  it("returns patchDiff and explanation on a valid input", async () => {
    const result = await generateRemediationPatch(VALID_INPUT);

    expect(result.patchDiff).toBe(MOCK_OUTPUT.patchDiff);
    expect(result.explanation).toBe(MOCK_OUTPUT.explanation);
  });

  it("calls getAiInstance() so local model routing is respected", async () => {
    await generateRemediationPatch(VALID_INPUT);

    expect(getAiInstance).toHaveBeenCalledOnce();
  });

  it("calls getDefaultModelRef() so the correct model is used", async () => {
    await generateRemediationPatch(VALID_INPUT);

    expect(getDefaultModelRef).toHaveBeenCalledOnce();
  });

  it("passes the model from getDefaultModelRef to ai.generate", async () => {
    await generateRemediationPatch(VALID_INPUT);

    const callArgs = mockGenerate.mock.calls[0][0];
    expect(callArgs.model).toBe("mock-model");
  });

  it("includes filePath, findingDescription and vulnerableCode in the prompt", async () => {
    await generateRemediationPatch(VALID_INPUT);

    const callArgs = mockGenerate.mock.calls[0][0];
    expect(callArgs.prompt).toContain(VALID_INPUT.filePath);
    expect(callArgs.prompt).toContain(VALID_INPUT.findingDescription);
    expect(callArgs.prompt).toContain(VALID_INPUT.vulnerableCode);
  });

  it("falls back to static guidance when the AI provider throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGenerate.mockRejectedValue(new Error("Request timed out"));

    const result = await generateRemediationPatch(VALID_INPUT);

    expect(result.patchDiff).toBe("");
    expect(result.explanation).toMatch(/temporarily unavailable/);
  });

  it("falls back to static guidance when the model returns no output", async () => {
    mockGenerate.mockResolvedValue({ output: null });

    const result = await generateRemediationPatch(VALID_INPUT);

    expect(result.patchDiff).toBe("");
    expect(result.explanation).toMatch(/temporarily unavailable/);
  });

  it("throws on invalid input (missing required fields)", async () => {
    await expect(generateRemediationPatch({ vulnerableCode: "x" } as any)).rejects.toThrow();
  });
});

describe("generateRemediationPatchFlow (backwards-compat re-export)", () => {
  it("is the same function as generateRemediationPatch", () => {
    expect(generateRemediationPatchFlow).toBe(generateRemediationPatch);
  });

  it("still works when called via the old export name", async () => {
    const result = await generateRemediationPatchFlow(VALID_INPUT);
    expect(result.patchDiff).toBe(MOCK_OUTPUT.patchDiff);
  });
});
