import { z } from "genkit";
import { getAiInstance, getDefaultModelRef } from "@/ai/genkit";
import { queryLiveThreatIntelligence } from "../../../cli/src/threat-intel";

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
 */
export async function generateRemediationPatch(input: PatchInput): Promise<PatchOutput> {
  const validatedInput = PatchInputSchema.parse(input);

  const activeAi = getAiInstance();
  const activeModel = getDefaultModelRef();

  let threatIntelContext = "";
  try {
    threatIntelContext = await queryLiveThreatIntelligence(
      `${validatedInput.findingDescription} ${validatedInput.filePath}`,
    );
  } catch {
    // Graceful degradation if MCP server module cannot be loaded
  }

  const prompt = `You are an expert security engineer. Your task is to generate a unified diff patch to fix the following security vulnerability.

File: ${validatedInput.filePath}

Vulnerability: ${validatedInput.findingDescription}
${threatIntelContext ? `\nLive Threat Intelligence Context:\n${threatIntelContext}\n` : ""}
Current Code:

\`\`\`
${validatedInput.vulnerableCode}
\`\`\`

Provide ONLY the unified diff patch that fixes this issue securely. Do not include markdown code blocks around the diff, just the raw diff text. Also provide a brief 1-sentence explanation of the fix.
`;

  try {
    const { output } = await activeAi.generate({
      model: activeModel as Awaited<Parameters<typeof activeAi.generate>[0]>["model"],
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
 */
export const generateRemediationPatchFlow = generateRemediationPatch;
