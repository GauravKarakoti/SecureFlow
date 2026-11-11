"use server";

import {
  __internal,
  evaluateForInjection,
  isRateLimitError,
  isTimeoutError,
  withRetry,
} from "./security-helpers";
import { getAiInstance, getDefaultModelRef, getSecurityExplanationModelChain } from "@/ai/genkit";
import { recordAiFallbackEvent } from "@/lib/audit/ai-fallback-audit";
import {
  InsufficientVRAMError,
  insufficientVramMessage,
  isInsufficientMemoryError,
  isLocalModelEnabled,
} from "@/ai/local-model";
import {
  AISecurityExplanationInputSchema,
  AISecurityExplanationOutputSchema,
  SYSTEM_PROMPT,
  type AISecurityExplanationInput,
  type AISecurityExplanationOutput,
} from "./security-explanation-schemas";
import { detectWeb3Ecosystem, web3SecurityExplanation } from "./web3-security-explanations";
import {
  createExplanationCacheKey,
  getCachedExplanation,
  getModelId,
  setCachedExplanation,
} from "@/lib/explanation-cache";
import {
  runModelChain,
  buildExplanationResult,
  shouldCacheExplanation,
} from "./security-explanation-core";

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

  // Cache lookup. The key includes the active model and prompt version, so switching
  // models (or LOCAL_AI_URL) or editing the prompt never serves stale explanations.
  // A hit skips the injection checks and the LLM call entirely.
  const activeAi = getAiInstance();
  const activeModel = getDefaultModelRef();
  const cacheKey = createExplanationCacheKey({
    findingType: validatedInput.findingType,
    severity: validatedInput.severity,
    fileLocation: validatedInput.fileLocation,
    codeSnippet: validatedInput.codeSnippet,
    description: validatedInput.description,
    model: getModelId(activeModel),
  });

  const cached = await getCachedExplanation(cacheKey);
  if (cached) {
    return AISecurityExplanationOutputSchema.parse(cached);
  }

  // Set to true only when the model returned a real, parseable explanation.
  // Error/fallback text ("Signal lost", rate limit, timeout) must never be cached.
  let cacheable = false;
  // A smaller fallback model's answer is never cached under the primary model's key.
  let usedFallbackModel = false;

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

  const modelsToTry: unknown[] = getSecurityExplanationModelChain();
  let selectedModel: unknown = modelsToTry[0];

  let responseText: string | undefined;
  let parsedContent: { explanation?: string; remediationSuggestions?: string } | undefined;

  try {
    const { value: res, model } = await runModelChain(
      modelsToTry,
      (candidate) =>
        withRetry(
          () =>
            activeAi.generate({
              model: candidate as any,
              system: SYSTEM_PROMPT,
              prompt,
              config: {
                maxOutputTokens: 3000,
                temperature: 0.1,
              },
            }),
          {
            initialDelayMs: 100,
          },
        ),
      ({ from, to, reason }) => {
        if (reason === "rate_limit" || reason === "timeout") {
          void recordAiFallbackEvent({
            fromModel: getModelId(from),
            toModel: getModelId(to),
            reason,
          });
        }
      },
    );

    selectedModel = model;
    usedFallbackModel = model !== modelsToTry[0];
    responseText = (res as { text: string }).text;
  } catch (genError) {
    if (isInsufficientMemoryError(genError)) {
      const message =
        genError instanceof InsufficientVRAMError
          ? genError.message
          : insufficientVramMessage([getModelId(activeModel)]);

      console.warn(`[LOCAL_AI] ${message}`);

      parsedContent = {
        explanation: message,
        remediationSuggestions:
          "AI explanation unavailable on this hardware: review the static scanner details, or use a smaller local model.",
      };
    } else if (isRateLimitError(genError)) {
      console.warn("AI provider rate limit reached:", genError);

      parsedContent = {
        explanation:
          "Groq API rate limit reached (429). The Professor will retry transmission shortly.",
        remediationSuggestions:
          "Rate limit active: review static scanner details or wait a moment before re-evaluating.",
      };
    } else if (isTimeoutError(genError)) {
      console.warn("AI provider connection timed out:", genError);

      parsedContent = {
        explanation: "Groq API connection timed out. The Professor is standing by.",
        remediationSuggestions:
          "Connection timed out: verify model availability and inspect the vulnerability manually.",
      };
    } else {
      console.error("AI generation failed:", genError);

      parsedContent = {
        explanation: "Signal lost. The Professor is recalculating.",
        remediationSuggestions:
          "Adjust the plan: lock down the perimeter manually and review the intercepted payload.",
      };
    }
  }

  if (responseText && !parsedContent) {
    const { result, usedParseFallback } = buildExplanationResult({
      input: validatedInput,
      finalResponse: { text: responseText },
      injectionPreFilterFlagged,
    });

    parsedContent = result;
    cacheable = shouldCacheExplanation({
      usedParseFallback,
      model: selectedModel,
      models: modelsToTry,
    });
  }

  const explanation: string = parsedContent?.explanation || "No explanation provided.";

  // Output consistency check: even with structural isolation and the pre-filter, catch cases
  // where the model's explanation ended up contradicting the finding's known severity.
  const consistencyFlagged = contradictsSeverity(validatedInput.severity, explanation);

  const output = AISecurityExplanationOutputSchema.parse({
    explanation,
    remediationSuggestions:
      parsedContent?.remediationSuggestions || "No remediation suggestions provided.",
    promptInjectionSuspected: injectionPreFilterFlagged || consistencyFlagged,
  });

  if (cacheable && parsedContent?.explanation) {
    await setCachedExplanation(cacheKey, output);
  }

  return output;
}
