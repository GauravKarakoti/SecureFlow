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

You MUST respond strictly with a valid JSON object containing exactly two keys: "explanation" and "remediationSuggestions". Do not include any other text.`;

  const chatCompletion = await groq.chat.completions.create({
    messages: [
      { 
        role: 'system', 
        content: 'You are an elite application security assistant. Keep all outputs ultra-short, concise, and output ONLY a valid JSON object containing the keys "explanation" and "remediationSuggestions".' 
      },
      { role: 'user', content: prompt }
    ],
    // model: 'llama-3.3-70b-versatile',
    model: 'llama-3.1-8b-instant',
    response_format: { type: 'json_object' }
  });

  const responseText = chatCompletion.choices[0]?.message?.content || '{}';
  let parsedContent;
  
  try {
    parsedContent = JSON.parse(responseText);
  } catch (error) {
    parsedContent = {
      explanation: 'No explanation provided.',
      remediationSuggestions: 'No remediation suggestions provided.'
    };
  }

  return AISecurityExplanationOutputSchema.parse({
    explanation: parsedContent.explanation || 'No explanation provided.',
    remediationSuggestions: parsedContent.remediationSuggestions || 'No remediation suggestions provided.'
  });
}