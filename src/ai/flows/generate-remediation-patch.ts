import { z } from "genkit";
import { getAiInstance, getDefaultModelRef } from "@/ai/genkit";

const PatchInputSchema = z.object({
  vulnerableCode: z.string(),
  findingDescription: z.string(),
  filePath: z.string(),
});

export const PatchOutputSchema = z.object({
  patchDiff: z.string().describe("The unified diff patch to fix the vulnerability."),
  explanation: z.string().describe("Brief explanation of the changes made."),
});

export type PatchInput = z.infer<typeof PatchInputSchema>;
export type PatchOutput = z.infer<typeof PatchOutputSchema>;

/**
 * Generate a unified diff patch that fixes a security vulnerability.
 *
 * Previously this was wrapped in `ai.defineFlow(...)` using the Groq singleton
 * `ai`, but the handler inside called `getAiInstance().generate(...)` which
 * returns a *different* Genkit instance when LOCAL_AI_URL is set. The flow
 * registry and the execution instance were mismatched, causing a Genkit
 * registry error at runtime in local model mode.
 *
 * The fix follows the same pattern as `developerReceivesAISecurityExplanations`:
 * a plain async function that resolves the active instance and model at call
 * time via `getAiInstance()` and `getDefaultModelRef()`. No `defineFlow`
 * wrapper is needed — the function is called directly by its callers.
 */
export async function generateRemediationPatch(input: PatchInput): Promise<PatchOutput> {
  const validatedInput = PatchInputSchema.parse(input);

  const activeAi = getAiInstance();
  const activeModel = getDefaultModelRef();

  const prompt = `You are an expert security engineer. Your task is to generate a unified diff patch to fix the following security vulnerability.

File: ${validatedInput.filePath}

Vulnerability: ${validatedInput.findingDescription}

Current Code:

\`\`\`
${validatedInput.vulnerableCode}
\`\`\`

Provide ONLY the unified diff patch that fixes this issue securely. Do not include markdown code blocks around the diff, just the raw diff text. Also provide a brief 1-sentence explanation of the fix.

`;

  try {
    const { output } = await activeAi.generate({
      model: activeModel as any,
      prompt,
      output: { schema: PatchOutputSchema, format: "json" },
    });

    if (output) {
      return output;
    }
  } catch (error) {
    console.warn("[REMEDIATION] AI provider unavailable, using static fallback:", error);
  }

  return {
    patchDiff: "",
    explanation:
      "The AI remediation service is temporarily unavailable. Please review the vulnerability manually and apply the appropriate secure remediation before merging.",
  };
}

/**
 * @deprecated Use `generateRemediationPatch` directly.
 *
 * Kept as a re-export so any existing callers that imported
 * `generateRemediationPatchFlow` continue to compile without changes.
 * The underlying implementation is now a plain async function — the
 * `ai.defineFlow` wrapper has been removed to fix the Genkit instance
 * mismatch when LOCAL_AI_URL is set.
 */
export const generateRemediationPatchFlow = generateRemediationPatch;
