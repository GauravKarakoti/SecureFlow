'use server';

import "dotenv/config";
import { __internal } from './security-helpers';
import { ai, securityExplanationModel } from '@/ai/genkit';
import {
  AISecurityExplanationInputSchema,
  AISecurityExplanationOutputSchema,
  SYSTEM_PROMPT,
  type AISecurityExplanationInput,
  type AISecurityExplanationOutput,
} from './security-explanation-schemas';

const { detectPromptInjection, contradictsSeverity, buildPrompt } = __internal;

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

  // Explicitly route to the fastest Groq model (see securityExplanationModel
  // in @/ai/genkit). Issue #217 asked for the security-explanation flows to
  // NOT just rely on the default Genkit config; pinning the model here makes
  // the latency-critical path independent of GROQ_MODEL changes that might
  // otherwise swap in a slower model.
  const { text: responseText } = await ai.generate({
    model: securityExplanationModel,
    system: SYSTEM_PROMPT,
    prompt,
    config: {
      maxOutputTokens: 3000,
      temperature: 0.1,
    }
  });

  let parsedContent;
  try {
    const withoutThoughts = responseText.replace(/<think>[\s\S]*?(<\/think>|$)/ig, '');
    const jsonMatch = withoutThoughts.match(/[\{\[][\s\S]*[\}\]]/);
    
    if (!jsonMatch) {
      throw new Error("No JSON object found in response");
    }

    parsedContent = JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error("Failed to parse explanation JSON:", error);
    console.error("RAW OUTPUT WAS:\n", responseText); 
    
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