import { z } from "genkit";
import { getAiInstance, getDefaultModelRef } from "@/ai/genkit";
import { isRateLimitError, isTimeoutError } from "@/ai/resilience";
import { queryLiveThreatIntelligence } from "../../../cli/src/threat-intel";

const PatchInputSchema = z.object({
  vulnerableCode: z.string(),
  findingDescription: z.string(),
  filePath: z.string(),
});

export const PatchOutputSchema = z.object({
  patchDiff: z.string().describe("The unified diff patch to fix the vulnerability."),
  explanation: z.string().describe("Brief explanation of the changes made."),
});

export type PatchInput = z.infer<typeof PatchInputSchema>;
export type PatchOutput = z.infer<typeof PatchOutputSchema>;

/** Why no patch was produced (#1513). */
export type RemediationFailureReason = "rate_limit" | "timeout" | "unavailable";

/**
 * A patch, or the static fallback. `failureReason` is set only on the fallback, so
 * callers (and the UI) can tell a rate limit from any other failure. It is not part
 * of `PatchOutputSchema`, so it is never sent to the model as part of the schema.
 */
export type PatchResult = PatchOutput & { failureReason?: RemediationFailureReason };

const FALLBACK_BASE = "The AI remediation service is temporarily unavailable";
const FALLBACK_TAIL =
  "review the vulnerability manually and apply the appropriate secure remediation before merging.";

const FALLBACK_EXPLANATIONS: Record<RemediationFailureReason, string> = {
  rate_limit: `${FALLBACK_BASE}: the AI provider rate limit was reached. Please retry in a minute, or ${FALLBACK_TAIL}`,
  timeout: `${FALLBACK_BASE}: the AI provider timed out. Please retry, or ${FALLBACK_TAIL}`,
  unavailable: `${FALLBACK_BASE}. Please ${FALLBACK_TAIL}`,
};

function classifyFailure(error: unknown): RemediationFailureReason {
  if (isRateLimitError(error)) return "rate_limit";
  if (isTimeoutError(error)) return "timeout";
  return "unavailable";
}

const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 500;

/**
 * Retry `operation` on rate limits (429) and timeouts with exponential backoff and a
 * little jitter (#1513). Any other error is thrown straight away, so an out-of-memory
 * error is not retried. Delays are skipped under test.
 *
 * This is not `withRetry` from `./security-helpers`: importing that module builds a
 * Groq client at import time, which breaks every test that merely loads this flow.
 */
async function retryWithBackoff<T>(operation: () => Promise<T>): Promise<T> {
  const skipDelay = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt > MAX_RETRIES || (!isRateLimitError(error) && !isTimeoutError(error))) {
        throw error;
      }
      const delay = skipDelay ? 0 : INITIAL_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 200;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Generate a unified diff patch that fixes a security vulnerability.
 *
 * Rate limits (429) and timeouts are retried with exponential backoff (#1513).
 * Other errors, such as out-of-memory, are not retried.
 */
export async function generateRemediationPatch(input: PatchInput): Promise<PatchResult> {
  const validatedInput = PatchInputSchema.parse(input);

  const activeAi = getAiInstance();
  const activeModel = getDefaultModelRef();

  let threatIntelContext = "";
  try {
    threatIntelContext = await queryLiveThreatIntelligence(
      `${validatedInput.findingDescription} ${validatedInput.filePath}`,
    );
  } catch {
    // Graceful degradation if MCP server module cannot be loaded
  }

  const prompt = `You are an expert security engineer. Your task is to generate a unified diff patch to fix the following security vulnerability.

File: ${validatedInput.filePath}

Vulnerability: ${validatedInput.findingDescription}
${threatIntelContext ? `\nLive Threat Intelligence Context:\n${threatIntelContext}\n` : ""}
Current Code:

\`\`\`
${validatedInput.vulnerableCode}
\`\`\`

Provide ONLY the unified diff patch that fixes this issue securely. Do not include markdown code blocks around the diff, just the raw diff text. Also provide a brief 1-sentence explanation of the fix.
`;

  let failureReason: RemediationFailureReason = "unavailable";

  try {
    const { output } = await retryWithBackoff(() =>
      activeAi.generate({
        model: activeModel as Awaited<Parameters<typeof activeAi.generate>[0]>["model"],
        prompt,
        output: { schema: PatchOutputSchema, format: "json" },
      }),
    );

    if (output) {
      return output;
    }
  } catch (error) {
    failureReason = classifyFailure(error);
    console.warn(
      `[REMEDIATION] AI provider unavailable (${failureReason}), using static fallback:`,
      error,
    );
  }

  return {
    patchDiff: "",
    explanation: FALLBACK_EXPLANATIONS[failureReason],
    failureReason,
  };
}

/**
 * @deprecated Use `generateRemediationPatch` directly.
 */
export const generateRemediationPatchFlow = generateRemediationPatch;
