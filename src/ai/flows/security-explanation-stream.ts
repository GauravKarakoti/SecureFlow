import "dotenv/config";
import { __internal, isRateLimitError, isTimeoutError, withRetry } from './security-helpers';
import { ai, securityExplanationModel } from '@/ai/genkit';
import {
  AISecurityExplanationApiSchema,
  AISecurityExplanationInputSchema,
  AISecurityExplanationOutputSchema,
  SYSTEM_PROMPT,
  type AISecurityExplanationInput,
  type AISecurityExplanationOutput,
} from './security-explanation-schemas';

const { detectPromptInjection, contradictsSeverity, buildPrompt } = __internal;

/** Streamed while the explanation text is still arriving (typewriter-style UI). */
export type StreamExplanationChunkEvent = { type: 'chunk'; explanation: string };
/** Emitted once, after the full response has arrived and all safety checks have run. */
export type StreamExplanationDoneEvent = { type: 'done'; result: AISecurityExplanationOutput };
/** Emitted if generation fails partway through; the caller should fall back gracefully. */
export type StreamExplanationErrorEvent = { type: 'error'; message: string };
export type StreamExplanationEvent =
  | StreamExplanationChunkEvent
  | StreamExplanationDoneEvent
  | StreamExplanationErrorEvent;

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
  options: { signal?: AbortSignal } = {}
): AsyncGenerator<StreamExplanationEvent, void, unknown> {
  const { signal } = options;
  if (signal?.aborted) return;

  let validatedInput: AISecurityExplanationInput;
  try {
    validatedInput = AISecurityExplanationInputSchema.parse(input);
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : 'Invalid input.' };
    return;
  }

  const injectionPreFilterFlagged =
    detectPromptInjection(validatedInput.codeSnippet) || detectPromptInjection(validatedInput.description);

  const prompt = buildPrompt(validatedInput);

  try {
    // Explicitly route to the fastest Groq model with retries for rate limits and timeouts on stream setup.
    const { stream, response } = await withRetry(
      async () =>
        ai.generateStream({
          model: securityExplanationModel,
          system: SYSTEM_PROMPT,
          prompt,
          ...(signal ? { abortSignal: signal } : {}),
          output: {
            format: 'json',
            schema: AISecurityExplanationApiSchema,
          },
          config: {
            maxOutputTokens: 3000,
            temperature: 0.1,
          },
        }),
      {
        initialDelayMs: process.env.NODE_ENV === 'test' ? 10 : 100,
      }
    );

    let lastExplanation = '';
    for await (const chunk of stream) {
      // Stop pulling from the model as soon as the caller has disconnected.
      if (signal?.aborted) return;
      const partial = chunk.output as Partial<AISecurityExplanationOutput> | undefined;
      if (partial?.explanation && partial.explanation !== lastExplanation) {
        lastExplanation = partial.explanation;
        yield { type: 'chunk', explanation: lastExplanation };
      }
    }

    const finalResponse = await response;
    let parsedContent: Partial<AISecurityExplanationOutput> = {};

    if (finalResponse.output) {
      parsedContent = finalResponse.output as AISecurityExplanationOutput;
    } else {
      try {
        const withoutThoughts = finalResponse.text.replace(/<think>[\s\S]*?(<\/think>|$)/ig, '');
        const jsonMatch = withoutThoughts.match(/[\{\[][\s\S]*[\}\]]/);

        if (!jsonMatch) {
          throw new Error("No JSON object found in response");
        }

        parsedContent = JSON.parse(jsonMatch[0]);
      } catch (error) {
        console.error("Failed to parse stream explanation JSON:", error);
        console.error("RAW STREAM OUTPUT WAS:\n", finalResponse.text);

        parsedContent = {
          explanation: 'Signal lost. The Professor is recalculating.',
          remediationSuggestions: 'Adjust the plan: lock down the perimeter manually and review the intercepted payload.',
        };
      }
    }

    const explanation: string = parsedContent.explanation || lastExplanation || 'No explanation provided.';
    const consistencyFlagged = contradictsSeverity(validatedInput.severity, explanation);

    const result = AISecurityExplanationOutputSchema.parse({
      explanation,
      remediationSuggestions: parsedContent.remediationSuggestions || 'No remediation suggestions provided.',
      promptInjectionSuspected: injectionPreFilterFlagged || consistencyFlagged,
    });

    // The final, fully-validated explanation is always the authoritative text, even if it
    // differs slightly from the last streamed partial (e.g. the partial JSON parser dropped a
    // trailing fragment) - callers should render `result.explanation` once `done` arrives.
    yield { type: 'done', result };
  } catch (err) {
    const isRateLimit = isRateLimitError(err);
    const isTimeout = isTimeoutError(err);
    const message = isRateLimit
      ? 'AI provider rate limit reached (429). Please wait a moment and try again.'
      : isTimeout
      ? 'AI provider connection timed out. Please try again.'
      : err instanceof Error
      ? err.message
      : 'AI generation failed.';
    yield {
      type: 'error',
      message,
    };
  }
}