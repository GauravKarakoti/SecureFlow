/**
 * Local Model Provider for Data Privacy & Air-Gapped Scanning (#892)
 *
 * Enterprise security teams are often unwilling to send proprietary code to
 * cloud-based LLMs. This module provides a Genkit-compatible local inference
 * backend that routes AI calls to a locally-running Ollama or vLLM instance (or
 * any OpenAI-compatible server) instead of Groq.
 *
 * Supported Local Providers:
 *   - Ollama (default: http://localhost:11434/v1, model: llama3 / codellama)
 *   - vLLM (default: http://localhost:8000/v1, model: meta-llama/Meta-Llama-3-8B-Instruct)
 *   - Custom OpenAI-compatible on-prem endpoints
 *
 * Activation:
 *   - Generic: Set LOCAL_AI_URL (e.g. http://localhost:11434/v1) and optionally LOCAL_AI_MODEL.
 *   - Ollama: Set OLLAMA_URL or LOCAL_AI_PROVIDER=ollama.
 *   - vLLM: Set VLLM_URL or LOCAL_AI_PROVIDER=vLLM.
 *
 * CLI usage:
 *   secureflow scan --local
 *   secureflow scan --ollama [--ollama-model <tag>]
 *   secureflow scan --vllm [--vllm-model <tag>]
 *
 * Security properties preserved:
 *   - 100% Air-gapped: No code or metadata leaves the local machine/network.
 *   - All prompt-injection pre-filters and output consistency checks still run.
 *   - Zero external egress: hosted AI scanning is skipped.
 *   - The same Zod schemas validate input/output regardless of provider.
 */

import { genkit } from "genkit";
import { openAICompatible } from "@genkit-ai/compat-oai";

// ---------------------------------------------------------------------------
// Configuration & Defaults
// ---------------------------------------------------------------------------

/** Default Ollama OpenAI-compatible base URL. */
export const DEFAULT_OLLAMA_URL = "http://localhost:11434/v1";
/** Default Ollama model tag. */
export const DEFAULT_OLLAMA_MODEL = "llama3";

/** Default vLLM OpenAI-compatible base URL. */
export const DEFAULT_VLLM_URL = "http://localhost:8000/v1";
/** Default vLLM model identifier. */
export const DEFAULT_VLLM_MODEL = "meta-llama/Meta-Llama-3-8B-Instruct";

/** Default local AI base URL (Ollama standard). */
export const DEFAULT_LOCAL_AI_URL = DEFAULT_OLLAMA_URL;
/** Default local model name. */
export const DEFAULT_LOCAL_AI_MODEL = DEFAULT_OLLAMA_MODEL;

export type LocalModelProvider = "ollama" | "vllm" | "custom";

export interface LocalModelConfig {
  /** Base URL of the local OpenAI-compatible inference server (normalized to end with /v1). */
  baseUrl: string;
  /** Model name/tag to use (e.g. "llama3", "codellama", "mistral", "meta-llama/Meta-Llama-3-8B-Instruct"). */
  model: string;
  /** Provider type: "ollama", "vllm", or "custom". */
  provider?: LocalModelProvider;
  /** Optional API key for secured on-prem / cluster endpoints (defaults to "local"). */
  apiKey?: string;
}

/**
 * Normalizes a local AI endpoint URL to guarantee a valid OpenAI-compatible `/v1` path.
 *
 * Handles bare domains/ports (e.g. `http://localhost:11434` -> `http://localhost:11434/v1`)
 * and removes accidental trailing slashes.
 *
 * A URL that already has a path is the caller's chosen API base and is kept.
 * Custom OpenAI-compatible gateways do not all end in `/v1`
 * (`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai`,
 * `https://generativelanguage.googleapis.com/v1beta/openai`), and appending
 * one sends every request to a path that does not exist.
 */
export function normalizeLocalAiUrl(rawUrl: string): string {
  const url = rawUrl.trim().replace(/\/+$/, "");

  let hasPath: boolean;
  try {
    hasPath = new URL(url).pathname !== "/";
  } catch {
    // Not a parseable absolute URL: keep the old behaviour.
    hasPath = url.endsWith("/v1");
  }

  return hasPath ? url : `${url}/v1`;
}

/**
 * Checks whether an endpoint URL is local or private network to verify air-gapped data residency.
 *
 * The RFC 1918 prefixes only mean anything on an IPv4 literal: `10.example.com`
 * and `192.168.attacker.net` are ordinary public hostnames. A URL that cannot be
 * parsed cannot be shown to be local either, so it is not.
 */
export function isAirGappedEndpoint(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const isIPv4Literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      (isIPv4Literal &&
        (hostname.startsWith("10.") ||
          hostname.startsWith("192.168.") ||
          /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname))) ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".corp") ||
      hostname.endsWith(".lan") ||
      hostname.endsWith(".cluster.local")
    );
  } catch {
    return false;
  }
}

/**
 * Resolve local model configuration from environment variables.
 *
 * Supports:
 *   - Dedicated Ollama settings: `OLLAMA_URL`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`
 *   - Dedicated vLLM settings: `VLLM_URL`, `VLLM_BASE_URL`, `VLLM_MODEL`
 *   - Generic local settings: `LOCAL_AI_URL`, `LOCAL_AI_MODEL`, `LOCAL_AI_PROVIDER`, `LOCAL_AI_API_KEY`
 */
export function resolveLocalModelConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LocalModelConfig | null {
  const providerEnv = env.LOCAL_AI_PROVIDER?.toLowerCase().trim() as LocalModelProvider | undefined;

  // 1. Explicit vLLM configuration
  const vllmUrl = env.VLLM_URL?.trim() || env.VLLM_BASE_URL?.trim();
  const vllmModel = env.VLLM_MODEL?.trim();

  // 2. Explicit Ollama configuration
  const ollamaUrl = env.OLLAMA_URL?.trim() || env.OLLAMA_BASE_URL?.trim();
  const ollamaModel = env.OLLAMA_MODEL?.trim();

  // 3. Generic Local AI configuration
  const localUrl = env.LOCAL_AI_URL?.trim();
  const localModel = env.LOCAL_AI_MODEL?.trim();
  const apiKey = env.LOCAL_AI_API_KEY?.trim() || "local";

  // Check if vLLM is specifically requested
  if (providerEnv === "vllm" || vllmUrl || (vllmModel && !localUrl && !ollamaUrl)) {
    const rawUrl = vllmUrl || localUrl || DEFAULT_VLLM_URL;
    const model = vllmModel || localModel || DEFAULT_VLLM_MODEL;
    return {
      baseUrl: normalizeLocalAiUrl(rawUrl),
      model,
      provider: "vllm",
      apiKey,
    };
  }

  // Check if Ollama is specifically requested
  if (providerEnv === "ollama" || ollamaUrl || (ollamaModel && !localUrl && !vllmUrl)) {
    const rawUrl = ollamaUrl || localUrl || DEFAULT_OLLAMA_URL;
    const model = ollamaModel || localModel || DEFAULT_OLLAMA_MODEL;
    return {
      baseUrl: normalizeLocalAiUrl(rawUrl),
      model,
      provider: "ollama",
      apiKey,
    };
  }

  // Check generic LOCAL_AI_URL
  if (localUrl) {
    let detectedProvider: LocalModelProvider = "custom";
    if (localUrl.includes(":11434")) {
      detectedProvider = "ollama";
    } else if (localUrl.includes(":8000")) {
      detectedProvider = "vllm";
    }

    return {
      baseUrl: normalizeLocalAiUrl(localUrl),
      model:
        localModel || (detectedProvider === "vllm" ? DEFAULT_VLLM_MODEL : DEFAULT_LOCAL_AI_MODEL),
      provider: providerEnv || detectedProvider,
      apiKey,
    };
  }

  return null;
}

/**
 * Whether local model mode is active.
 *
 * True when `LOCAL_AI_URL`, `OLLAMA_URL`, `VLLM_URL`, or `LOCAL_AI_PROVIDER` is set in the environment.
 */
export function isLocalModelEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return resolveLocalModelConfig(env) !== null;
}

/**
 * Test connectivity to a locally-running Ollama or vLLM server.
 */
export async function pingLocalModel(
  config: LocalModelConfig,
  timeoutMs: number = 3000,
): Promise<{ ok: boolean; provider?: LocalModelProvider; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const endpoint = `${config.baseUrl}/models`;
    const res = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey || "local"}`,
      },
      signal: controller.signal,
    });

    if (res.ok) {
      return { ok: true, provider: config.provider };
    }
    return {
      ok: false,
      error: `Server responded with status ${res.status}: ${res.statusText}`,
      provider: config.provider,
    };
  } catch (err: any) {
    return {
      ok: false,
      error:
        err?.name === "AbortError" ? `Connection timed out after ${timeoutMs}ms` : err?.message,
      provider: config.provider,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Genkit instance factory
// ---------------------------------------------------------------------------

/**
 * Build a Genkit instance configured for a local OpenAI-compatible server.
 *
 * Uses `@genkit-ai/compat-oai` (already a project dependency) so no new
 * packages are needed. Both Ollama and vLLM expose OpenAI-compatible `/v1` endpoints.
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
        apiKey: config.apiKey || "local",
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

// ---------------------------------------------------------------------------
// Insufficient GPU memory handling (#1140)
// ---------------------------------------------------------------------------

/**
 * Comma-separated smaller model tags to try, in order, when the active local
 * model cannot be loaded because the GPU/system lacks the memory for it
 * (e.g. `LOCAL_AI_FALLBACK_MODELS=llama3.2:3b,llama3.2:1b`).
 *
 * Local mode never falls back to a cloud provider, so these are always models
 * served by the same local endpoint. Blank entries and the active model itself
 * are dropped. Returns `[]` when local mode is off or nothing is configured.
 */
export function resolveLocalFallbackModels(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const config = resolveLocalModelConfig(env);
  if (!config) return [];

  const seen = new Set<string>([config.model]);
  const fallbacks: string[] = [];
  for (const raw of (env.LOCAL_AI_FALLBACK_MODELS ?? "").split(",")) {
    const model = raw.trim();
    if (model && !seen.has(model)) {
      seen.add(model);
      fallbacks.push(model);
    }
  }
  return fallbacks;
}

/**
 * Phrases local inference servers use when a model does not fit in memory.
 * Deliberately specific: a bare "memory" or "CUDA" also shows up in unrelated errors.
 *
 *   - Ollama:  "model requires more system memory (X GiB) than is available (Y GiB)"
 *   - llama.cpp / CUDA: "CUDA error: out of memory", "failed to allocate ... buffer"
 *   - vLLM:    "CUDA out of memory", "No available memory for the cache blocks"
 */
const INSUFFICIENT_MEMORY_PATTERNS: readonly RegExp[] = [
  /requires more (?:system )?memory/i,
  /out of memory/i,
  /\bOOM\b/,
  /insufficient (?:v?ram|(?:gpu |system )?memory)/i,
  /not enough (?:v?ram|(?:gpu |system )?memory)/i,
  /(?:failed|unable) to allocate/i,
  /no available memory/i,
  /cudaMalloc failed/i,
];

/**
 * Whether an error thrown by a local model server means the model does not fit
 * in the available VRAM / memory. Such an error is not retryable (the same model
 * will fail the same way); the right responses are a smaller model or a warning.
 */
export function isInsufficientMemoryError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof InsufficientVRAMError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return INSUFFICIENT_MEMORY_PATTERNS.some((pattern) => pattern.test(msg));
}

/** One-line, actionable message for an out-of-memory failure (no stack trace). */
export function insufficientVramMessage(modelsTried: readonly string[]): string {
  const tried = modelsTried.map((m) => `"${m}"`).join(", ") || "the active model";
  return (
    `Not enough GPU memory to load local model ${tried}. ` +
    `Switch to a smaller model (for example LOCAL_AI_MODEL=llama3.2:3b) ` +
    `or list smaller ones in LOCAL_AI_FALLBACK_MODELS.`
  );
}

/**
 * Thrown once every configured local model has failed to load for lack of
 * memory. Carries a ready-to-print message so callers can show it as-is.
 */
export class InsufficientVRAMError extends Error {
  readonly modelsTried: string[];

  constructor(modelsTried: readonly string[]) {
    super(insufficientVramMessage(modelsTried));
    this.name = "InsufficientVRAMError";
    this.modelsTried = [...modelsTried];
  }
}
