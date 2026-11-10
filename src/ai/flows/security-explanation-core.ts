
import { InsufficientVRAMError, isInsufficientMemoryError } from "@/ai/local-model";
import { getModelId } from "@/lib/explanation-cache";
import { isRateLimitError, isTimeoutError } from "./security-helpers";
import {
  AISecurityExplanationOutputSchema,
  type AISecurityExplanationInput,
  type AISecurityExplanationOutput,
} from "./security-explanation-schemas";
import { __internal } from "./security-helpers";

const { contradictsSeverity, buildPrompt } = __internal;

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type FallbackReason =
  | "rate_limit"
  | "timeout"
  | "insufficient_memory";

export function prepareExplanation(input: AISecurityExplanationInput) {
  return {
    prompt: buildPrompt(input),
  };
}

export function extractTokenUsage(
  response?: { usage?: TokenUsage } | null,
): TokenUsage | undefined {
  if (!response?.usage) return undefined;

  const inputTokens = response.usage.inputTokens ?? 0;
  const outputTokens = response.usage.outputTokens ?? 0;

  return {
    inputTokens,
    outputTokens,
    totalTokens:
      response.usage.totalTokens ?? inputTokens + outputTokens,
  };
}

export async function runModelChain<TModel, TResult>(
  models: TModel[],
  attempt: (model: TModel) => Promise<TResult>,
  onFallback?: (info: {
    from: TModel;
    to: TModel;
    reason: FallbackReason;
    error: unknown;
  }) => void,
): Promise<{ value: TResult; model: TModel }> {
  if (!models.length) {
    throw new Error("Model chain is empty.");
  }

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const next = models[i + 1];

    try {
      return {
        value: await attempt(model),
        model,
      };
    } catch (error) {
      if (isInsufficientMemoryError(error)) {
        if (next === undefined) {
          throw new InsufficientVRAMError(
            models.map((m) => getModelId(m as any)),
          );
        }

        console.warn(
          `[AI_FALLBACK] Model ${String(model)} does not fit in GPU memory. Switching to ${String(next)}`,
        );

        onFallback?.({
          from: model,
          to: next,
          reason: "insufficient_memory",
          error,
        });

        continue;
      }

      if (
        next !== undefined &&
        (isRateLimitError(error) || isTimeoutError(error))
      ) {
        const reason = isRateLimitError(error)
          ? "rate_limit"
          : "timeout";

        console.warn(
          `[AI_FALLBACK] Model ${String(model)} failed. Switching to ${String(next)}`,
        );

        onFallback?.({
          from: model,
          to: next,
          reason,
          error,
        });

        continue;
      }

      throw error;
    }
  }

  throw new Error("Model chain exhausted.");
}

export function buildExplanationResult(args: {
  input: AISecurityExplanationInput;
  finalResponse: {
    output?: unknown;
    text?: string;
  };
  injectionPreFilterFlagged: boolean;
  lastExplanation?: string;
}) {
  const {
    input,
    finalResponse,
    injectionPreFilterFlagged,
    lastExplanation = "",
  } = args;

  let parsed: Partial<AISecurityExplanationOutput> = {};
  let usedParseFallback = false;

  if (finalResponse.output) {
    parsed = finalResponse.output as AISecurityExplanationOutput;
  } else {
    try {
      const withoutThoughts = (finalResponse.text ?? "").replace(
        /<think>[\s\S]*?(<\/think>|$)/gi,
        "",
      );

      const match = withoutThoughts.match(/[\{\[][\s\S]*[\}\]]/);

      if (!match) {
        throw new Error("No JSON object found in response");
      }

      parsed = JSON.parse(match[0]);
    } catch (error) {
      console.error("Failed to parse explanation JSON:", error);

      usedParseFallback = true;

      parsed = {
        explanation: "Signal lost. The Professor is recalculating.",
        remediationSuggestions:
          "Adjust the plan: lock down the perimeter manually and review the intercepted payload.",
      };
    }
  }

  const explanation =
    parsed.explanation ||
    lastExplanation ||
    "No explanation provided.";

  const result = AISecurityExplanationOutputSchema.parse({
    explanation,
    remediationSuggestions:
      parsed.remediationSuggestions ||
      "No remediation suggestions provided.",
    promptInjectionSuspected:
      injectionPreFilterFlagged ||
      contradictsSeverity(input.severity, explanation),
  });

  return {
    result,
    usedParseFallback,
  };
}

export function shouldCacheExplanation(args: {
  usedParseFallback: boolean;
  model: unknown;
  models: unknown[];
}): boolean {
  return (
    !args.usedParseFallback &&
    args.model === args.models[0]
  );
}

export function toUserFacingError(error: unknown): string {
  if (isRateLimitError(error)) {
    return "AI provider rate limit reached (429). Please wait a moment and try again.";
  }

  if (isTimeoutError(error)) {
    return "AI provider connection timed out. Please try again.";
  }

  return error instanceof Error
    ? error.message
    : "AI generation failed.";
}
