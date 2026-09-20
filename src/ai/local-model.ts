/**
 * Local Model Provider for Data Privacy (#892)
 *
 * Enterprise security teams are often unwilling to send proprietary code to
 * cloud-based LLMs. This module provides a Genkit-compatible local inference
 * backend that routes AI calls to a locally-running Ollama instance (or any
 * OpenAI-compatible server) instead of Groq.
 *
 * Activation:
 *   Set LOCAL_AI_URL in your environment (e.g. http://localhost:11434/v1) and
 *   optionally LOCAL_AI_MODEL (defaults to "llama3"). No code changes needed.
 *
 * CLI usage:
 *   secureflow scan --local
 *   (sets LOCAL_AI_URL=http://localhost:11434/v1 for that invocation)
 *
 * Security properties preserved:
 *   - All prompt-injection pre-filters and output consistency checks still run.
 *   - No code leaves the machine when LOCAL_AI_URL is set.
 *   - The same Zod schemas validate input/output regardless of provider.
 */

import { genkit } from "genkit";
import { openAICompatible } from "@genkit-ai/compat-oai";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default Ollama OpenAI-compatible base URL. */
export const DEFAULT_LOCAL_AI_URL = "http://localhost:11434/v1";

/** Default local model name (Ollama model tag). */
export const DEFAULT_LOCAL_AI_MODEL = "llama3";

export interface LocalModelConfig {
  /** Base URL of the local OpenAI-compatible inference server. */
  baseUrl: string;
  /** Model name/tag to use (e.g. "llama3", "codellama", "mistral"). */
  model: string;
}

/**
 * Resolve local model configuration from environment variables.
 *
 * `LOCAL_AI_URL` activates local mode. `LOCAL_AI_MODEL` overrides the model.
 * Both have sensible defaults so the only required variable is `LOCAL_AI_URL`.
 */
export function resolveLocalModelConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LocalModelConfig | null {
  const baseUrl = env.LOCAL_AI_URL?.trim();
  if (!baseUrl) return null;

  return {
    baseUrl,
    model: env.LOCAL_AI_MODEL?.trim() || DEFAULT_LOCAL_AI_MODEL,
  };
}

/**
 * Whether local model mode is active.
 *
 * True when `LOCAL_AI_URL` is set in the environment. Used by flows to decide
 * which Genkit instance and model reference to use.
 */
export function isLocalModelEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return resolveLocalModelConfig(env) !== null;
}

// ---------------------------------------------------------------------------
// Genkit instance factory
// ---------------------------------------------------------------------------

/**
 * Build a Genkit instance configured for a local OpenAI-compatible server.
 *
 * Uses `@genkit-ai/compat-oai` (already a project dependency) so no new
 * packages are needed. Ollama exposes an OpenAI-compatible `/v1` endpoint
 * out of the box.
 *
 * The instance is created fresh per call so tests can inject different configs
 * without module-level singleton pollution.
 */
export function createLocalAiInstance(config: LocalModelConfig) {
  return genkit({
    plugins: [
      openAICompatible({
        name: "openai",
        baseURL: config.baseUrl,
        // Ollama does not require an API key but the plugin requires a non-empty
        // string. A placeholder satisfies the type without sending credentials.
        apiKey: "local",
      }),
    ],
  });
}

/**
 * The fully-qualified model string for a local config, in the format Genkit
 * expects: `<pluginName>/<modelName>`.
 */
export function localModelRef(config: LocalModelConfig): string {
  return `openai/${config.model}`;
}
