'use server';

import "dotenv/config";
import { __internal } from './security-helpers';
import { ai, defaultModel } from '@/ai/genkit';
import {
  AISecurityExplanationInputSchema,
  AISecurityExplanationOutputSchema,
  SYSTEM_PROMPT,
  type AISecurityExplanationInput,
  type AISecurityExplanationOutput,
} from './security-explanation-schemas';

const { detectPromptInjection, contradictsSeverity, buildPrompt } = __internal;

export type { AISecurityExplanationInput, AISecurityExplanationOutput };

export async function developerReceivesAISecurityExplanations(
  input: AISecurityExplanationInput
): Promise<AISecurityExplanationOutput> {
  const validatedInput = AISecurityExplanationInputSchema.parse(input);

  // Pre-filter runs on the raw, attacker-controlled fields (codeSnippet + description, since
  // both flow straight from the PR diff / scanner narrative) BEFORE anything is sent to the LLM.
  // This is advisory: a match doesn't block the explanation, it just tells the reviewer to trust
  // the static severity badge over the AI narrative for this specific finding.
  const injectionPreFilterFlagged =
    detectPromptInjection(validatedInput.codeSnippet) || detectPromptInjection(validatedInput.description);

  const prompt = buildPrompt(validatedInput);

  const { text: responseText } = await ai.generate({
    model: defaultModel,
    system: SYSTEM_PROMPT,
    prompt,
    output: { format: 'json' },
  });

  let parsedContent;
  try {
    parsedContent = JSON.parse(responseText);
  } catch {
    parsedContent = {
      explanation: 'Signal lost. The Professor is recalculating.',
      remediationSuggestions: 'Adjust the plan: lock down the perimeter manually and review the intercepted payload.'
    };
  }

  const explanation: string = parsedContent.explanation || 'No explanation provided.';

  // Output consistency check: even with structural isolation and the pre-filter, catch cases
  // where the model's explanation ended up contradicting the finding's known severity.
  const consistencyFlagged = contradictsSeverity(validatedInput.severity, explanation);

  return AISecurityExplanationOutputSchema.parse({
    explanation,
    remediationSuggestions: parsedContent.remediationSuggestions || 'No remediation suggestions provided.',
    promptInjectionSuspected: injectionPreFilterFlagged || consistencyFlagged,
  });
}
