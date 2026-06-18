'use server';
/**
 * @fileOverview A Groq-powered flow that generates plain-English explanations and remediation suggestions for security findings.
 *
 * - developerReceivesAISecurityExplanations - A function that handles the AI explanation process.
 * - AISecurityExplanationInput - The input type for the developerReceivesAISecurityExplanations function.
 * - AISecurityExplanationOutput - The return type for the developerReceivesAISecurityExplanations function.
 */

import { z } from 'zod';
import Groq from 'groq-sdk';

const AISecurityExplanationInputSchema = z.object({
  findingType: z
    .string()
    .describe('The type of security finding (e.g., Hardcoded OpenAI API key).'),
  severity: z.string().describe('The severity of the finding (e.g., CRITICAL, HIGH, MEDIUM, LOW).'),
  description: z.string().describe('A detailed description of the security issue from the scanner.'),
  fileLocation: z.string().describe('The file path and line number where the finding was detected.'),
  codeSnippet: z.string().describe('The relevant code snippet related to the finding.'),
});
export type AISecurityExplanationInput = z.infer<typeof AISecurityExplanationInputSchema>;

const AISecurityExplanationOutputSchema = z.object({
  explanation: z
    .string()
    .describe('A plain-English explanation of the security finding, easily understandable by a developer.'),
  remediationSuggestions: z
    .string()
    .describe('Actionable and practical remediation steps to fix the security issue.'),
});
export type AISecurityExplanationOutput = z.infer<typeof AISecurityExplanationOutputSchema>;

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export async function developerReceivesAISecurityExplanations(
  input: AISecurityExplanationInput
): Promise<AISecurityExplanationOutput> {
  // Validate the input
  const validatedInput = AISecurityExplanationInputSchema.parse(input);

  const prompt = `You are a security expert. Your task is to explain a security finding in plain English and provide practical remediation suggestions.

The explanation should be concise, clear, and easy for a developer to understand. Focus on the impact and risk.
The remediation suggestions should be actionable, specific steps to fix the issue, including best practices.

Security Finding Details:
Type: ${validatedInput.findingType}
Severity: ${validatedInput.severity}
Description: ${validatedInput.description}
File Location: ${validatedInput.fileLocation}
Code Snippet:
"""
${validatedInput.codeSnippet}
"""

Please provide a plain-English explanation and specific remediation suggestions based on the above finding.
Respond strictly in JSON format. The response MUST exactly match this structure, where both values are plain strings:
{
  "explanation": "<string containing the plain-English explanation>",
  "remediationSuggestions": "<string containing the actionable steps>"
}`;

  // Make the API call to Groq
  const chatCompletion = await groq.chat.completions.create({
    messages: [
      { role: 'system', content: 'You are a helpful assistant that strictly outputs JSON.' },
      { role: 'user', content: prompt }
    ],
    model: 'llama-3.3-70b-versatile', 
    response_format: { type: 'json_object' },
  });

  const responseText = chatCompletion.choices[0]?.message?.content || '{}';
  const result = JSON.parse(responseText);

  // Validate the Groq output against the expected schema before returning
  return AISecurityExplanationOutputSchema.parse(result);
}