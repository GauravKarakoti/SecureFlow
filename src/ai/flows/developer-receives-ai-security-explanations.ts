'use server';

import { z } from 'zod';
import Groq from 'groq-sdk';
import "dotenv/config";

const AISecurityExplanationInputSchema = z.object({
  findingType: z.string(),
  severity: z.string(),
  description: z.string(),
  fileLocation: z.string(),
  codeSnippet: z.string(),
});
export type AISecurityExplanationInput = z.infer<typeof AISecurityExplanationInputSchema>;

const AISecurityExplanationOutputSchema = z.object({
  explanation: z.string(),
  remediationSuggestions: z.string(),
});
export type AISecurityExplanationOutput = z.infer<typeof AISecurityExplanationOutputSchema>;

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export async function developerReceivesAISecurityExplanations(
  input: AISecurityExplanationInput
): Promise<AISecurityExplanationOutput> {
  const validatedInput = AISecurityExplanationInputSchema.parse(input);

  const prompt = `You are a security expert auditing a Pull Request. Your task is to briefly explain a finding and provide highly actionable remediation steps.

CRITICAL LENGTH CONSTRAINTS:
- Explanation: Must be maximum 2 sentences long. State only the direct impact.
- Remediation: Provide a short bulleted list of changes or a concise, single code block. Do NOT write an introduction, multiple phases, or an essay.

Security Finding Details:
Type: ${validatedInput.findingType}
Severity: ${validatedInput.severity}
Description: ${validatedInput.description}
File Location: ${validatedInput.fileLocation}
Code Snippet:
"""
${validatedInput.codeSnippet}
"""

You MUST respond strictly using the following structural tag markers to enclose your answers:

<explanation_block>
Concise explanation (max 2 sentences)...
</explanation_block>

<remediation_block>
Short, bulleted remediation or single compact code snippet here...
</remediation_block>`;

  const chatCompletion = await groq.chat.completions.create({
    messages: [
      { 
        role: 'system', 
        content: 'You are an elite application security assistant. Keep all outputs ultra-short, concise, and populate the requested blocks.' 
      },
      { role: 'user', content: prompt }
    ],
    // model: 'llama-3.3-70b-versatile',
    model: 'llama-3.1-8b-instant'
  });

  const responseText = chatCompletion.choices[0]?.message?.content || '';

  const explanationMatch = responseText.match(/<explanation_block>([\s\S]*?)<\/explanation_block>/);
  const remediationMatch = responseText.match(/<remediation_block>([\s\S]*?)<\/remediation_block>/);

  const explanation = explanationMatch ? explanationMatch[1].trim() : 'No explanation provided.';
  const remediationSuggestions = remediationMatch ? remediationMatch[1].trim() : 'No remediation suggestions provided.';

  return AISecurityExplanationOutputSchema.parse({
    explanation,
    remediationSuggestions
  });
}