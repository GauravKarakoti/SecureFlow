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
  remediationSuggestions: z.any().transform((val) => typeof val === 'string' ? val : JSON.stringify(val)),
});
export type AISecurityExplanationOutput = z.infer<typeof AISecurityExplanationOutputSchema>;

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || 'dummy-key-for-build',
});

function sanitizeForPrompt(input: string): string {
  return input
    .replace(/```/g, '~~~')
    .replace(/ignore previous/gi, '')
    .replace(/disregard (all )?instructions/gi, '')
    .slice(0, 2000);
}

export async function developerReceivesAISecurityExplanations(
  input: AISecurityExplanationInput
): Promise<AISecurityExplanationOutput> {
  const validatedInput = AISecurityExplanationInputSchema.parse(input);

  const prompt = `Incoming transmission. A breach has been intercepted in the operation.

Threat Class: ${validatedInput.findingType}
Threat Level: ${validatedInput.severity}
Reconnaissance: ${sanitizeForPrompt(validatedInput.description)}
Compromised Sector: ${sanitizeForPrompt(validatedInput.fileLocation)}
Intercepted Payload:
"""
${sanitizeForPrompt(validatedInput.codeSnippet)}
"""

CRITICAL CONSTRAINTS:
- "explanation": 2 sentences maximum. Cold, precise radio-comm style. Describe exactly how this breach compromises The Vault.
- "remediationSuggestions": Frame as "adjustments to the plan". Bulleted commands or a single code block. No preamble.

Respond ONLY with a valid JSON object with keys "explanation" and "remediationSuggestions".`;

  const chatCompletion = await groq.chat.completions.create({
    messages: [
      {
        role: 'system',
        content: 'You are "The Professor" — calm, calculating, and precise. You speak in clipped radio-comm transmissions during a high-stakes operation. Every security flaw is a threat to The Vault. Every fix is an adjustment to the plan. Output ONLY a valid JSON object with keys "explanation" and "remediationSuggestions". No prose outside the JSON.'
      },
      { role: 'user', content: prompt }
    ],
    model: 'llama-3.1-8b-instant',
    response_format: { type: 'json_object' },
    stream: true,
  });

  let responseText = '';
  for await (const chunk of chatCompletion) {
    responseText += chunk.choices[0]?.delta?.content || '';
  }

  let parsedContent;
  try {
    parsedContent = JSON.parse(responseText);
  } catch {
    parsedContent = {
      explanation: 'Signal lost. The Professor is recalculating.',
      remediationSuggestions: 'Adjust the plan: lock down the perimeter manually and review the intercepted payload.'
    };
  }

  return AISecurityExplanationOutputSchema.parse({
    explanation: parsedContent.explanation || 'No explanation provided.',
    remediationSuggestions: parsedContent.remediationSuggestions || 'No remediation suggestions provided.'
  });
}