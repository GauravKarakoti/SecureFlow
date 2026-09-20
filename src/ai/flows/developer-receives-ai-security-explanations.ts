"use server";

import "dotenv/config";
import {
  __internal,
  evaluateForInjection,
  isRateLimitError,
  isTimeoutError,
  withRetry,
} from "./security-helpers";
import {
  ai,
  defaultModel,
  securityExplanationModel,
  getAiInstance,
  getDefaultModelRef,
} from "@/ai/genkit";
import {
  AISecurityExplanationInputSchema,
  AISecurityExplanationOutputSchema,
  SYSTEM_PROMPT,
  type AISecurityExplanationInput,
  type AISecurityExplanationOutput,
} from "./security-explanation-schemas";
import { detectWeb3Ecosystem, web3SecurityExplanation } from "./web3-security-explanations";

const { contradictsSeverity, buildPrompt } = __internal;

/**
 * Returns true when the finding originates from a Web3 / ZK-circuit file.
 *
 * Used by the dispatcher below to route to the ecosystem-specific prompt
 * templates in web3-security-explanations.ts instead of the generic flow.
 */
function isWeb3Finding(input: AISecurityExplanationInput): boolean {
  const ecosystem = detectWeb3Ecosystem(input.fileLocation, input.findingType);
  return ecosystem !== "generic-web3";
}

export async function developerReceivesAISecurityExplanations(
  input: AISecurityExplanationInput,
): Promise<AISecurityExplanationOutput> {
  const validatedInput = AISecurityExplanationInputSchema.parse(input);

  // Route Web3 / ZK-circuit findings to the ecosystem-specific flow.
  // detectWeb3Ecosystem() identifies .sol, .rs, .circom, .leo files and
  // Web3-specific finding types (reentrancy, underconstrained, CPI, etc.).
  // The web3 flow runs the same injection pre-filter and consistency checks
  // but uses domain-specific system prompts and prompt templates.
  if (isWeb3Finding(validatedInput)) {
    return web3SecurityExplanation(validatedInput);
  }

  // Two-layer injection check runs on the raw, attacker-controlled fields BEFORE anything is
  // sent to the main Genkit engine:
  //   1. Heuristic pre-filter (synchronous, zero cost).
  //   2. If the heuristic fires, a secondary lightweight LLM call confirms it.
  // Advisory only — a match sets promptInjectionSuspected so reviewers know to trust the
  // static severity badge over the AI narrative, but the explanation is still generated.
  const [snippetResult, descResult] = await Promise.all([
    evaluateForInjection(validatedInput.codeSnippet),
    evaluateForInjection(validatedInput.description),
  ]);
  const injectionPreFilterFlagged = snippetResult.flagged || descResult.flagged;

  const prompt = buildPrompt(validatedInput);

  let responseText: string | undefined;
  let parsedContent: { explanation?: string; remediationSuggestions?: string } | undefined;

  try {
    // Route to local model when LOCAL_AI_URL is set, otherwise use the pinned
    // fast Groq model. Retry logic and fallback chain are preserved for cloud
    // mode; local mode uses a single model (no cloud fallback by design).
    const activeAi = getAiInstance();
    const activeModel = getDefaultModelRef();
    const res = await withRetry(
      () =>
        activeAi.generate({
          model: activeModel as any,
          system: SYSTEM_PROMPT,
          prompt,
          config: {
            maxOutputTokens: 3000,
            temperature: 0.1,
          },
        }),
      {
        initialDelayMs: process.env.NODE_ENV === "test" ? 10 : 100,
      },
    );
    responseText = res.text;
  } catch (genError) {
    if (isRateLimitError(genError)) {
      console.warn("Groq API rate limit reached after retries:", genError);
      parsedContent = {
        explanation:
          "Groq API rate limit reached (429). The Professor will retry transmission shortly.",
        remediationSuggestions:
          "Rate limit active: review static scanner details or wait a moment before re-evaluating.",
      };
    } else if (isTimeoutError(genError)) {
      console.warn("Groq API connection timed out after retries:", genError);
      parsedContent = {
        explanation: "Groq API connection timed out. The Professor is standing by.",
        remediationSuggestions:
          "Connection timed out: verify model availability and inspect the vulnerability manually.",
      };
    } else {
      console.error("AI generation failed after retries:", genError);
      parsedContent = {
        explanation: "Signal lost. The Professor is recalculating.",
        remediationSuggestions:
          "Adjust the plan: lock down the perimeter manually and review the intercepted payload.",
      };
    }
  }

  if (responseText && !parsedContent) {
    try {
      const withoutThoughts = responseText.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "");
      const jsonMatch = withoutThoughts.match(/[\{\[][\s\S]*[\}\]]/);

      if (!jsonMatch) {
        throw new Error("No JSON object found in response");
      }

      parsedContent = JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error("Failed to parse explanation JSON:", error);
      console.error("RAW OUTPUT WAS:\n", responseText);

      parsedContent = {
        explanation: "Signal lost. The Professor is recalculating.",
        remediationSuggestions:
          "Adjust the plan: lock down the perimeter manually and review the intercepted payload.",
      };
    }
  }

  const explanation: string = parsedContent?.explanation || "No explanation provided.";

  // Output consistency check: even with structural isolation and the pre-filter, catch cases
  // where the model's explanation ended up contradicting the finding's known severity.
  const consistencyFlagged = contradictsSeverity(validatedInput.severity, explanation);

  return AISecurityExplanationOutputSchema.parse({
    explanation,
    remediationSuggestions:
      parsedContent?.remediationSuggestions || "No remediation suggestions provided.",
    promptInjectionSuspected: injectionPreFilterFlagged || consistencyFlagged,
  });
}
