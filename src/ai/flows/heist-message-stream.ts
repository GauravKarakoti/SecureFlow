import 'dotenv/config';
import { z } from 'zod';
import { ai, defaultModel } from '@/ai/genkit';
import { isRateLimitError, isTimeoutError, withRetry } from './security-helpers';

// ── Input schema ──────────────────────────────────────────────────────────────
export const HeistMessageInputSchema = z.object({
  projectName: z.string().min(1).max(120),
  score: z.number().int().min(0).max(100).optional(),
  rank: z.enum(['S', 'A', 'B', 'C', 'D']).optional(),
  findingsCount: z.number().int().min(0).optional(),
});

export type HeistMessageInput = z.infer<typeof HeistMessageInputSchema>;

// ── Event types ───────────────────────────────────────────────────────────────

/** A new fragment of the streaming text arrived (text-so-far snapshot). */
export type HeistChunkEvent = { type: 'chunk'; text: string };

/** All text has arrived; final complete message. */
export type HeistDoneEvent  = { type: 'done'; message: string };

/** AI generation failed; caller should fall back to static lines. */
export type HeistErrorEvent = { type: 'error'; message: string };

export type HeistStreamEvent = HeistChunkEvent | HeistDoneEvent | HeistErrorEvent;

// ── Fallback message (mirrored in the client for offline / error paths) ───────
export const FALLBACK_HEIST_MESSAGE =
  'Bella ciao, accomplice. The operation on this vault is complete. ' +
  'The Professor always has a plan. Zero traces remain.';

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are "The Professor" from Money Heist — hyper-analytical, calm, authoritative, and a master strategist who speaks in measured, calculated sentences. You are transmitting an encrypted intelligence briefing over a secure channel to your network of accomplices (occasionally referencing team city codenames such as Tokyo, Berlin, Denver, Rio, Nairobi, Helsinki, Moscow, or Palermo) confirming that a security audit (a "heist") on a software target has been executed to perfection.

Rules:
- Strictly speak in "The Professor" persona: hyper-analytical, calm, authoritative, and methodical.
- Structure your response like a high-stakes tactical briefing.
- Write 4 to 6 short, impact-driven sentences.
- Use city-based codenames (e.g., Tokyo, Berlin, Denver, Nairobi, Rio) occasionally when addressing the user, the team, or assigning operational roles.
- Maintain the cyber-heist aesthetic: vault keycodes, encrypted telemetry, blueprint verification, zero traces.
- Do NOT use markdown or bullet points — plain prose only.
- Refer to the project by its exact name.
- Weave the score/rank/findings naturally if provided.
- End with a single, quiet closing line that signals the channel is going dark.
- Output raw text only — no JSON wrapper, no preamble.`;

function buildPrompt(input: HeistMessageInput): string {
  const parts: string[] = [
    `The target project is: ${input.projectName}.`,
  ];

  if (input.score !== undefined) {
    parts.push(`Security score: ${input.score}/100.`);
  }
  if (input.rank) {
    parts.push(`Clearance tier: Rank ${input.rank}.`);
  }
  if (input.findingsCount !== undefined) {
    parts.push(`Findings logged: ${input.findingsCount}.`);
  }

  parts.push('Generate The Professor\'s encrypted transmission now.');
  return parts.join(' ');
}

// ── Main streaming generator ──────────────────────────────────────────────────

export interface StreamHeistMessageOptions {
  /**
   * Aborts the underlying generation. Pass the request signal so a client
   * disconnecting mid-stream stops us paying for the rest of the completion.
   */
  signal?: AbortSignal;
}

/**
 * Streams a unique, cryptic "Professor-style" heist transmission for a given
 * share-link payload.
 *
 * Yields:
 *   - `chunk` events with the accumulated text as the model speaks (typewriter UI)
 *   - a single `done` event once the full message has arrived
 *   - a single `error` event if generation fails (caller should use FALLBACK_HEIST_MESSAGE)
 *
 * When `options.signal` aborts, the generator returns without yielding a
 * terminal event: an abort means the caller went away, which is not a failure
 * anyone is left to hear about.
 */
export async function* streamHeistMessage(
  input: HeistMessageInput,
  options: StreamHeistMessageOptions = {},
): AsyncGenerator<HeistStreamEvent, void, unknown> {
  const { signal } = options;

  if (signal?.aborted) return;

  // ── Validate input ──────────────────────────────────────────────────────────
  let validatedInput: HeistMessageInput;
  try {
    validatedInput = HeistMessageInputSchema.parse(input);
  } catch (err) {
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : 'Invalid input.',
    };
    return;
  }

  const prompt = buildPrompt(validatedInput);

  try {
    // ── Stream from Groq via Genkit with retries ──────────────────────────────
    // We ask for plain text output (no JSON schema) so the model doesn't wrap
    // the monologue in JSON structure — the prompt explicitly says "plain prose".
    const { stream, response } = await withRetry(
      async () =>
        ai.generateStream({
          model: defaultModel,
          system: SYSTEM_PROMPT,
          prompt,
          ...(signal ? { abortSignal: signal } : {}),
        }),
      {
        initialDelayMs: process.env.NODE_ENV === 'test' ? 10 : 100,
      }
    );

    let accumulatedText = '';

    for await (const chunk of stream) {
      // Stop pulling as soon as the caller is gone. Returning here finalises
      // the generator, which closes the underlying stream.
      if (signal?.aborted) return;

      // Genkit streams raw text chunks for non-JSON output.
      // chunk.text is the incremental delta; we accumulate it.
      const delta: string = chunk.text ?? '';
      if (delta) {
        accumulatedText += delta;
        yield { type: 'chunk', text: accumulatedText };
      }
    }

    if (signal?.aborted) return;

    // ── Await the final response to get the canonical complete text ─────────
    const finalResponse = await response;
    const finalText = (finalResponse.text ?? accumulatedText).trim();

    yield {
      type: 'done',
      message: finalText || FALLBACK_HEIST_MESSAGE,
    };
  } catch (err) {
    // An abort is the caller leaving, not a generation failure.
    if (signal?.aborted) return;

    const isRateLimit = isRateLimitError(err);
    const isTimeout = isTimeoutError(err);
    const message = isRateLimit
      ? 'Groq API rate limit reached (429). Falling back to default heist transmission.'
      : isTimeout
      ? 'Groq API connection timed out. Falling back to default heist transmission.'
      : err instanceof Error
      ? err.message
      : 'AI generation failed.';

    yield {
      type: 'error',
      message,
    };
  }
}
