import fs from "node:fs";
import { z } from "genkit";
import { getAiInstance, getDefaultModelRef } from "@/ai/genkit";
import {
  isRateLimitError,
  isTimeoutError,
  isVramConcurrencyError,
  getModelCircuitBreaker,
  CircuitBreakerError,
  CircuitState,
} from "@/ai/resilience";
import {
  InsufficientVRAMError,
  insufficientVramMessage,
  isInsufficientMemoryError,
  resolveLocalFallbackModels,
  resolveLocalModelConfig,
} from "@/ai/local-model";
import { queryLiveThreatIntelligence } from "../../../cli/src/threat-intel";
import { detectPromptInjection } from "./security-helpers";
import {
  verifyPatchInTempCopy,
  type PatchVerificationResult,
} from "@/lib/patch/patch-verifier";

const PatchInputSchema = z.object({
  vulnerableCode: z.string(),
  findingDescription: z.string(),
  filePath: z.string(),
  originalContent: z.string().optional(),
  verifyPatch: z.boolean().optional(),
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
export type PatchResult = PatchOutput & {
  failureReason?: RemediationFailureReason;
  verified?: boolean;
  readyFix?: boolean;
  note?: string;
};

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

  // Wrap AI inference call with circuit breaker to prevent blocking during provider outages (#1768)
  const modelKey =
    typeof activeModel === "string" ? activeModel : (activeModel as any)?.name || "default";
  const localConfig = resolveLocalModelConfig();
  const localFallbackRefs = localConfig
    ? resolveLocalFallbackModels().map((model) => `openai/${model}`)
    : [];
  const modelsToTry: unknown[] = [
    activeModel,
    ...localFallbackRefs.filter((ref) => ref !== activeModel && ref !== modelKey),
  ];
  let selectedModel: unknown = activeModel;
  let selectedBreaker = getModelCircuitBreaker(modelKey);
  const modelsAttempted: string[] = [];

  try {
    let output: PatchOutput | null = null;
    for (let i = 0; i < modelsToTry.length; i++) {
      const candidate = modelsToTry[i];
      const candidateKey =
        typeof candidate === "string" ? candidate : (candidate as any)?.name || "default";
      const candidateBreaker = getModelCircuitBreaker(candidateKey);
      modelsAttempted.push(candidateKey);

      try {
        output = await candidateBreaker.execute(async () => {
          const res = await retryWithBackoff(() =>
            activeAi.generate({
              model: candidate as Awaited<Parameters<typeof activeAi.generate>[0]>["model"],
              prompt,
              output: { schema: PatchOutputSchema, format: "json" },
            }),
          );
          return res.output;
        });
        selectedModel = candidate;
        selectedBreaker = candidateBreaker;
        break;
      } catch (candidateErr) {
        const hasNext = i < modelsToTry.length - 1;
        if (
          hasNext &&
          (isInsufficientMemoryError(candidateErr) ||
            isVramConcurrencyError(candidateErr) ||
            candidateErr instanceof CircuitBreakerError)
        ) {
          console.warn(
            `[LOCAL_AI] Remediation model ${candidateKey} unavailable under memory/circuit pressure. Switching to ${String(modelsToTry[i + 1])}`,
          );
          continue;
        }
        throw candidateErr;
      }
    }

    if (output) {
      if (
        detectPromptInjection(output.explanation || "") ||
        detectPromptInjection(output.patchDiff || "")
      ) {
        console.warn("[REMEDIATION] Prompt injection detected in AI patch output");
        return {
          patchDiff: "",
          explanation:
            "Generated patch was discarded due to detected prompt injection or security boundary violation.",
          failureReason: "unavailable",
          verified: false,
          readyFix: false,
          note: "Prompt injection detected in generated patch.",
        };
      }

      // If verification is disabled or no patch diff was generated, return as-is
      if (validatedInput.verifyPatch === false || !output.patchDiff || !output.patchDiff.trim()) {
        return {
          ...output,
          verified: false,
          readyFix: false,
        };
      }

      // Determine original file content for temporary copy verification
      let originalContent = validatedInput.originalContent;
      let realWorkspacePath: string | undefined;
      if (!originalContent) {
        if (fs.existsSync(validatedInput.filePath)) {
          try {
            originalContent = fs.readFileSync(validatedInput.filePath, "utf8");
            realWorkspacePath = validatedInput.filePath;
          } catch {
            // Fallback to vulnerable code if unreadable
          }
        }
      }
      if (!originalContent) {
        originalContent = validatedInput.vulnerableCode;
      }

      // Verify patch against isolated temporary copy
      const verification = await verifyPatchInTempCopy({
        filePath: validatedInput.filePath,
        originalContent,
        patchDiff: output.patchDiff,
        realWorkspacePath,
      });

      if (verification.verified) {
        return {
          patchDiff: output.patchDiff,
          explanation: output.explanation,
          verified: true,
          readyFix: true,
        };
      }

      // Verification failed: Retry once with the error as feedback
      console.warn(
        `[REMEDIATION] Patch verification failed (${verification.error}). Retrying once with error feedback...`,
      );

      const retryPrompt = `${prompt}

IMPORTANT: The previous patch failed automated verification:
${verification.error}

Please provide a corrected unified diff patch that:
1. Applies cleanly to the original file without any context or line mismatches.
2. Produces valid, error-free syntax for ${verification.language || "the language"}.
Provide ONLY the corrected raw unified diff patch and a brief 1-sentence explanation.`;

      let retryOutput: PatchOutput | null = null;
      try {
        retryOutput = await selectedBreaker.execute(async () => {
          const res = await retryWithBackoff(() =>
            activeAi.generate({
              model: selectedModel as Awaited<Parameters<typeof activeAi.generate>[0]>["model"],
              prompt: retryPrompt,
              output: { schema: PatchOutputSchema, format: "json" },
            }),
          );
          return res.output;
        });
      } catch (retryErr) {
        console.warn("[REMEDIATION] Retry patch generation failed:", retryErr);
      }

      if (retryOutput && retryOutput.patchDiff && retryOutput.patchDiff.trim()) {
        if (
          detectPromptInjection(retryOutput.explanation || "") ||
          detectPromptInjection(retryOutput.patchDiff || "")
        ) {
          console.warn("[REMEDIATION] Prompt injection detected in retry AI patch output");
          return {
            patchDiff: "",
            explanation:
              "Generated patch was discarded due to detected prompt injection or security boundary violation.",
            failureReason: "unavailable",
            verified: false,
            readyFix: false,
            note: "Prompt injection detected in generated patch.",
          };
        }

        const retryVerification = await verifyPatchInTempCopy({
          filePath: validatedInput.filePath,
          originalContent,
          patchDiff: retryOutput.patchDiff,
          realWorkspacePath,
        });

        if (retryVerification.verified) {
          return {
            patchDiff: retryOutput.patchDiff,
            explanation: retryOutput.explanation,
            verified: true,
            readyFix: true,
          };
        }
      }

      // If retry still fails, show the finding without a patch and a short note
      const shortNote = `Patch verification failed (${verification.error || "unable to apply cleanly or parse syntax"}). No ready fix available.`;
      return {
        patchDiff: "",
        explanation: output.explanation,
        verified: false,
        readyFix: false,
        note: shortNote,
      };
    }
  } catch (error) {
    if (isInsufficientMemoryError(error)) {
      const vramMsg =
        error instanceof InsufficientVRAMError
          ? error.message
          : insufficientVramMessage(modelsAttempted.length > 0 ? modelsAttempted : [modelKey]);
      console.warn(`[LOCAL_AI] ${vramMsg}`);
      return {
        patchDiff: "",
        explanation: `The AI remediation service is temporarily unavailable: ${vramMsg}`,
        failureReason: "unavailable",
        note: vramMsg,
      };
    }

    if (error instanceof CircuitBreakerError) {
      failureReason = "unavailable";
      console.warn(
        `[REMEDIATION] Circuit breaker open for model ${modelKey}; failing fast with static template:`,
        error.message,
      );
    } else {
      failureReason = classifyFailure(error);
      console.warn(
        `[REMEDIATION] AI provider unavailable (${failureReason}), using static fallback:`,
        error,
      );
    }
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
