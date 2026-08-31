import { defineFlow, defineSchema } from 'genkit';
import { z } from 'zod';
import { groq } from '@genkit-ai/groq';

// Schema for the AI output to ensure structured patch generation
const PatchOutputSchema = defineSchema({
  patchDiff: z.string().describe("The unified diff patch to fix the vulnerability."),
  explanation: z.string().describe("Brief explanation of the changes made.")
});

/**
 * Genkit AI Flow: Generate Remediation Patch
 * Analyzes a security finding and its surrounding code context to generate a unified diff patch.
 */
export const generateRemediationPatchFlow = defineFlow(
  {
    name: 'generateRemediationPatch',
    inputSchema: z.object({
      vulnerableCode: z.string(),
      findingDescription: z.string(),
      filePath: z.string()
    }),
    outputSchema: PatchOutputSchema,
  },
  async (input) => {
    const prompt = `
You are an expert security engineer. Your task is to generate a unified diff patch to fix the following security vulnerability.

File: ${input.filePath}
Vulnerability: ${input.findingDescription}
Current Code:
\`\`\`
${input.vulnerableCode}
\`\`\`

Provide ONLY the unified diff patch that fixes this issue securely. Do not include markdown code blocks around the diff, just the raw diff text. Also provide a brief 1-sentence explanation of the fix.
`;

    const result = await groq.generate({
      model: 'llama-3.1-8b-instant',
      prompt: prompt,
      output: { schema: PatchOutputSchema, format: 'json' }
    });

    return result.output;
  }
);
