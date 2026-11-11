import "dotenv/config";
import { getVulnerabilityMetadata } from "../../database/vulnerabilityDb";
import { __internal, withRetry } from "./security-helpers";
import { getAiInstance, getDefaultModelRef, getSecurityExplanationModelChain } from "@/ai/genkit";

import {
  runModelChain,
  buildExplanationResult,
  shouldCacheExplanation,
  extractTokenUsage,
  toUserFacingError,
} from "./security-explanation-core";

import {
  AISecurityExplanationApiSchema,
  AISecurityExplanationInputSchema,
  AISecurityExplanationOutputSchema,
  SYSTEM_PROMPT,
  type AISecurityExplanationInput,
  type AISecurityExplanationOutput,
} from "./security-explanation-schemas";
import {
  createExplanationCacheKey,
  getCachedExplanation,
  getModelId,
  setCachedExplanation,
} from "@/lib/explanation-cache";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface StreamOptions {
  vulnerabilityId: string;
  sourceCode: string;
  onChunk: (text: string) => void;
  onUsage?: (usage: TokenUsage) => void;
}

export function aggregateTokenUsage(usages: Array<TokenUsage | null | undefined>): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  return usages.reduce<{ inputTokens: number; outputTokens: number; totalTokens: number }>(
    (acc, usage) => {
      const input = usage?.inputTokens ?? 0;
      const output = usage?.outputTokens ?? 0;
      const total = usage?.totalTokens ?? input + output;
      return {
        inputTokens: acc.inputTokens + input,
        outputTokens: acc.outputTokens + output,
        totalTokens: acc.totalTokens + total,
      };
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

/**
 * Highly optimized, low-latency streaming pipeline for real-time security explanations.
 *
 * Previously used a hardcoded `new Groq()` client, which bypassed the local
 * model routing introduced in #892. When LOCAL_AI_URL is set, all AI calls
 * must route to the local inference server — no code should leave the machine.
 *
 * Fixed by using getAiInstance().generateStream() with getDefaultModelRef(),
 * matching the pattern already used by streamDeveloperSecurityExplanations()
 * in this same file.
 */
export async function streamSecurityExplanation({
  vulnerabilityId,
  sourceCode,
  onChunk,
  onUsage,
}: StreamOptions): Promise<TokenUsage | undefined> {
  try {
    const metadataPromise = getVulnerabilityMetadata(vulnerabilityId);

    const systemPrompt = `You are an expert security engineer. Analyze the provided source code for the specified vulnerability.
Provide a concise explanation, architectural impact, and immediate remediation steps. Use clear, plain text with markdown code snippets.`;

    const userPrompt = `Vulnerability ID: ${vulnerabilityId}\nSource Code:\n\`\`\`\n${sourceCode}\n\`\`\``;

    const metadata = await metadataPromise;
    const cvssText =
      metadata?.cvss !== null && metadata?.cvss !== undefined ? ` (CVSS: ${metadata.cvss})` : "";
    const contextualPrompt = metadata
      ? `${userPrompt}\nContextual Details: ${metadata.description}${cvssText}`
      : userPrompt;

    const activeAi = getAiInstance();
    const activeModel = getDefaultModelRef();

    const { stream, response } = await activeAi.generateStream({
      model: activeModel as any,
      system: systemPrompt,
      prompt: contextualPrompt,
      config: {
        temperature: 0.1,
        maxOutputTokens: 800,
      },
    });

    for await (const chunk of stream) {
      const textChunk = (chunk as any).text ?? (chunk as any).content ?? "";
      if (textChunk) {
        onChunk(textChunk);
      }
    }

    const finalResponse = await response;
    let usage: TokenUsage | undefined;
    if (finalResponse?.usage) {
      const inputTokens = finalResponse.usage.inputTokens ?? 0;
      const outputTokens = finalResponse.usage.outputTokens ?? 0;
      const totalTokens = finalResponse.usage.totalTokens ?? inputTokens + outputTokens;
      usage = { inputTokens, outputTokens, totalTokens };
      if (onUsage) {
        onUsage(usage);
      }
    }

    return usage;
  } catch (error) {
    console.error("[AI_STREAM_ERROR] Critical failure in streaming pipeline:", error);
    throw new Error("Streaming pipeline encountered an internal execution fault.");
  }
}

const { detectPromptInjection, buildPrompt } = __internal;

/** Streamed while the explanation text is still arriving (typewriter-style UI). */
export type StreamExplanationChunkEvent = { type: "chunk"; explanation: string };
/** Emitted once, after the full response has arrived and all safety checks have run. */
export type StreamExplanationDoneEvent = {
  type: "done";
  result: AISecurityExplanationOutput;
  usage?: TokenUsage;
};
/** Emitted if generation fails partway through; the caller should fall back gracefully. */
export type StreamExplanationErrorEvent = { type: "error"; message: string };
export type StreamExplanationEvent =
  StreamExplanationChunkEvent | StreamExplanationDoneEvent | StreamExplanationErrorEvent;

/**
 * Streaming variant of developerReceivesAISecurityExplanations.
 *
 * Yields `chunk` events with the accumulated explanation text as it arrives from the model
 * (Genkit's `generateStream` incrementally parses the partial JSON and hands back the
 * `explanation` field's value-so-far on each tick), so a caller can render it live rather than
 * waiting for the full response - the whole point being to cut perceived latency for the
 * "AI explanation" UI. All the same safety checks as the non-streaming flow (injection
 * pre-filter + output consistency check) still run on the complete text before the final `done`
 * event, so callers get identical guarantees - only the delivery is incremental.
 *
 * On any failure mid-stream, yields a single `error` event; callers should fall back to either
 * a static message or a retry via the non-streaming flow.
 */
export async function* streamDeveloperSecurityExplanations(
  input: AISecurityExplanationInput,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<StreamExplanationEvent, void, unknown> {
  const { signal } = options;
  if (signal?.aborted) return;

  let validatedInput: AISecurityExplanationInput;
  try {
    validatedInput = AISecurityExplanationInputSchema.parse(input);
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : "Invalid input." };
    return;
  }

  const injectionPreFilterFlagged =
    detectPromptInjection(validatedInput.codeSnippet) ||
    detectPromptInjection(validatedInput.description);

  const prompt = buildPrompt(validatedInput);

  try {
    const modelChain = getSecurityExplanationModelChain();
    const cacheKey = createExplanationCacheKey({
      ...validatedInput,
      model: getModelId(modelChain[0]),
    });

    const cached = await getCachedExplanation(cacheKey);
    if (cached) {
      if (signal?.aborted) return;
      yield { type: "chunk", explanation: cached.explanation };
      yield { type: "done", result: cached };
      return;
    }

    const streamResult = await runModelChain(modelChain, (activeModel) =>
      withRetry(
        async () => {
          const { stream, response } = getAiInstance().generateStream({
            model: activeModel as any,
            system: SYSTEM_PROMPT,
            prompt,
            ...(signal ? { abortSignal: signal } : {}),
            output: {
              format: "json",
              schema: AISecurityExplanationApiSchema,
            },
            config: {
              maxOutputTokens: 3000,
              temperature: 0.1,
            },
          });

          response.catch(() => {});

          const iterator = stream[Symbol.asyncIterator]();
          const first = await iterator.next();

          return { iterator, first, response };
        },
        {
          initialDelayMs: process.env.NODE_ENV === "test" ? 10 : 100,
        },
      ),
    );

    const activeModel = streamResult.model;
    const { iterator, first, response } = streamResult.value;

    let lastExplanation = "";

    for (let next = first; !next.done; next = await iterator.next()) {
      if (signal?.aborted) return;

      const partial = next.value.output as Partial<AISecurityExplanationOutput> | undefined;

      if (partial?.explanation && partial.explanation !== lastExplanation) {
        lastExplanation = partial.explanation;

        yield {
          type: "chunk",
          explanation: lastExplanation,
        };
      }
    }

    const finalResponse = await response;
    const { result, usedParseFallback } = buildExplanationResult({
      input: validatedInput,
      finalResponse,
      lastExplanation,
      injectionPreFilterFlagged,
    });

    if (
      shouldCacheExplanation({
        usedParseFallback,
        model: activeModel,
        models: modelChain,
      })
    ) {
      void setCachedExplanation(cacheKey, result);
    }

    const tokenUsage = extractTokenUsage(finalResponse);

    // The final, fully-validated explanation is always the authoritative text, even if it
    // differs slightly from the last streamed partial (e.g. the partial JSON parser dropped a
    // trailing fragment) - callers should render `result.explanation` once `done` arrives.
    yield {
      type: "done",
      result,
      ...(tokenUsage ? { usage: tokenUsage } : {}),
    };
  } catch (err) {
    yield {
      type: "error",
      message: toUserFacingError(err),
    };
  }
}
