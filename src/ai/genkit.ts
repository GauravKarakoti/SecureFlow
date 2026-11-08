import "dotenv/config";
import { genkit } from "genkit";
import { groq, gptOssx20b } from "genkitx-groq";
import {
  resolveLocalModelConfig,
  resolveLocalFallbackModels,
  isLocalModelEnabled,
  createLocalAiInstance,
  localModelRef,
} from "./local-model";

/**
 * Configuration options for AI security flow initialization.
 */
export interface SecurityAIConfig {
  temperature?: number;
  maxOutputTokens?: number;
  modelName: string;
}

/**
 * Genkit reference for a Groq model id.
 *
 * `GROQ_MODEL` holds the bare Groq id (`openai/gpt-oss-20b` in `.env.example`), which is
 * what the `groq-sdk` callers pass straight to the API. Genkit only knows the model under the
 * plugin's `groq/` namespace, and rejects the bare id with `NOT_FOUND: Model ... not found`.
 */
export function toGenkitGroqModel(modelId: string): string {
  const trimmed = modelId.trim();
  return trimmed.startsWith("groq/") ? trimmed : `groq/${trimmed}`;
}

/**
 * The Groq model used when `GROQ_MODEL` is unset or blank.
 *
 * Groq's current recommended default — see the deprecation note on
 * `defaultModel` below. The Genkit instance used to fall back to
 * `llama-3.1-8b-instant` instead, the model that note says was deprecated, so
 * the heist transmission (which runs on `DEFAULT_SECURITY_CONFIG.modelName`)
 * used a different model from the one documented for it.
 */
export const DEFAULT_GROQ_MODEL_ID = "openai/gpt-oss-20b";

/** `GROQ_MODEL` as a Genkit model reference, or undefined when it is unset or blank. */
function configuredGroqModel(): string | undefined {
  const modelId = process.env.GROQ_MODEL?.trim();
  return modelId ? toGenkitGroqModel(modelId) : undefined;
}

export const DEFAULT_SECURITY_CONFIG: SecurityAIConfig = {
  temperature: 0.2,
  maxOutputTokens: 1024,
  modelName: configuredGroqModel() ?? toGenkitGroqModel(DEFAULT_GROQ_MODEL_ID),
};

export const ai = genkit({
  plugins: [groq()],
  model: DEFAULT_SECURITY_CONFIG.modelName,
});

/**
 * Return the appropriate Genkit instance for the current environment.
 *
 * When `LOCAL_AI_URL` is set, returns a local Ollama-backed instance so no
 * code is sent to a cloud provider. Falls back to the Groq-backed `ai`
 * instance otherwise.
 *
 * Flows should call this instead of importing `ai` directly so the local-
 * model flag is respected without any per-flow conditional logic.
 */
export function getAiInstance() {
  const localConfig = resolveLocalModelConfig();
  if (localConfig) {
    return createLocalAiInstance(localConfig);
  }
  return ai;
}

/**
 * Return the model reference string appropriate for the current environment.
 *
 * Local mode: `openai/<LOCAL_AI_MODEL>` (routed to Ollama).
 * Cloud mode: the pinned `gptOssx20b` reference (Groq).
 */
export function getDefaultModelRef(): typeof gptOssx20b | string {
  const localConfig = resolveLocalModelConfig();
  if (localConfig) {
    return localModelRef(localConfig);
  }
  return securityExplanationModel;
}

/** Whether the app is currently configured to use a local inference server. */
export { isLocalModelEnabled };

// ── Default model (app-wide, configurable via GROQ_MODEL) ──────────────────
//
// `GROQ_MODEL` (default: `openai/gpt-oss-20b`) is the application-wide
// default used by flows that don't need a specific model (e.g. the heist-
// message flow, which benefits from a slightly larger model for prose
// quality and is not latency-critical).
//
// Groq deprecated `llama-3.1-8b-instant` on 2026-06-17 in favour of
// `openai/gpt-oss-20b` (see https://console.groq.com/docs/deprecations).
// `gpt-oss-20b` is Groq's current recommended default for general-purpose
// low-latency inference. Override via `GROQ_MODEL` if your account still
// has access to a deprecated model.

/**
 * Model reference flows should use unless they need to override it explicitly.
 *
 * Built the same way as `DEFAULT_SECURITY_CONFIG.modelName`. It used to be
 * `"groq/" + (process.env.GROQ_MODEL ?? default)`, which gave `"groq/"` for a
 * blank variable (`??` keeps `""`) and `"groq/groq/…"` for an id that already
 * had the namespace — the form `toGenkitGroqModel` exists to accept.
 */
export const defaultModel = configuredGroqModel() ?? toGenkitGroqModel(DEFAULT_GROQ_MODEL_ID);

export const securityExplanationModel = gptOssx20b;

/**
 * Tried in order when the primary model is rate-limited or times out.
 *
 * Groq's recommended replacements (https://console.groq.com/docs/deprecations)
 * for the models this list used to hold, all of which are shut down:
 * `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` on 2026-08-16, and
 * `mixtral-8x7b-32768` on 2025-03-20 (it is not even in `genkitx-groq`'s model
 * list). A request to any of them fails with an error that is neither a rate
 * limit nor a timeout, so the chain stopped at the first fallback and the
 * caller got that error instead of an explanation. Both entries below are
 * models the `genkitx-groq` plugin defines.
 */
export const securityExplanationFallbackModels = [
  "groq/openai/gpt-oss-120b",
  "groq/qwen/qwen3.6-27b",
] as const;

/**
 * Get ordered list of models for resilient failover execution.
 *
 * In local mode there is no cloud fallback when the operator has explicitly
 * opted out of cloud providers. The chain is the active local model followed
 * by any smaller local models in `LOCAL_AI_FALLBACK_MODELS`, tried when the
 * active one does not fit in GPU memory (#1140).
 */
export function getSecurityExplanationModelChain(): Array<typeof gptOssx20b | string> {
  const localConfig = resolveLocalModelConfig();
  if (localConfig) {
    return [
      localModelRef(localConfig),
      ...resolveLocalFallbackModels().map((model) => localModelRef({ ...localConfig, model })),
    ];
  }

  const customFallback = configuredGroqModel();
  if (customFallback) {
    return [customFallback, securityExplanationModel, ...securityExplanationFallbackModels];
  }
  return [securityExplanationModel, ...securityExplanationFallbackModels];
}

// ── AI Timeout & Resilient Fallback Execution (#1299) ──────────────────────
export const DEFAULT_AI_TIMEOUT_MS = 15_000;

export interface AiTimeoutOptions<T> {
  timeoutMs?: number;
  fallback?: () => Promise<T> | T;
  label?: string;
}

/**
 * Executes an AI operation within an explicit timeout boundary.
 * If the call exceeds the timeout deadline or experiences network stalls,
 * triggers the provided fallback callback or throws APIConnectionTimeoutError.
 */
export async function withAiTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: AiTimeoutOptions<T> = {},
): Promise<T> {
  const timeoutMs =
    options.timeoutMs ?? (Number(process.env.AI_TIMEOUT_MS) || DEFAULT_AI_TIMEOUT_MS);
  const controller = new AbortController();

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const err = new Error(
        `AI operation timed out after ${timeoutMs}ms${options.label ? ` (${options.label})` : ""}`,
      );
      err.name = "APIConnectionTimeoutError";
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } catch (error: any) {
    if (
      options.fallback &&
      (error?.name === "APIConnectionTimeoutError" ||
        error?.message?.includes("timed out") ||
        error?.status === 504 ||
        error?.code === "ETIMEDOUT")
    ) {
      return await options.fallback();
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── ArmorIQ Pre-Execution Intent Signing (#1275) ──────────────────────────
export {
  declareAndSignIntent as signAgentIntent,
  declareAndSignIntent as emitExecutionPlan,
  type ExecutionPlan,
  type SignedIntent,
} from "@/lib/armor/intent-signing";
export { agentRegistry, ARMORIQ_AGENT_IDS } from "@/lib/armor/agent-registry";
