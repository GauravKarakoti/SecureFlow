/**
 * Dynamic AI Model Configuration for Remediation and Security Explanations
 *
 * Allows operators and developers to configure AI providers (Groq, Ollama, vLLM, OpenAI, custom),
 * model names, and API base URLs via environment variables without editing code.
 *
 * Supported Environment Variables:
 * - Provider: AI_PROVIDER (aliases: REMEDIATION_MODEL_PROVIDER, REMEDIATION_PROVIDER, AI_MODEL_PROVIDER)
 *   Values: "groq" (default), "ollama", "vllm", "openai", "custom"
 * - Model Name: AI_MODEL (aliases: AI_MODEL_NAME, REMEDIATION_MODEL, REMEDIATION_MODEL_NAME)
 *   Values: e.g. "openai/gpt-oss-20b", "openai/gpt-oss-120b", "llama-3.3-70b-versatile", "llama3", "codellama", "gpt-4o-mini"
 * - Base URL: AI_BASE_URL (aliases: AI_API_BASE_URL, REMEDIATION_BASE_URL, REMEDIATION_MODEL_BASE_URL)
 *   Values: HTTP/HTTPS endpoint URL (e.g. "http://localhost:11434/v1")
 */

/**
 * Normalizes an AI endpoint URL to guarantee a valid path (appends /v1 if no path).
 */
export function normalizeAiUrl(rawUrl: string): string {
  const url = rawUrl.trim().replace(/\/+$/, "");

  let hasPath: boolean;
  try {
    hasPath = new URL(url).pathname !== "/";
  } catch {
    hasPath = url.endsWith("/v1");
  }

  return hasPath ? url : `${url}/v1`;
}

export const SUPPORTED_AI_PROVIDERS = ["groq", "ollama", "vllm", "openai", "custom"] as const;
export type AiProvider = (typeof SUPPORTED_AI_PROVIDERS)[number];

export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";
export const DEFAULT_OLLAMA_MODEL = "llama3";
export const DEFAULT_VLLM_MODEL = "meta-llama/Meta-Llama-3-8B-Instruct";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
export const DEFAULT_CUSTOM_MODEL = "custom-model";

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_VLLM_BASE_URL = "http://localhost:8000/v1";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export interface AiModelConfig {
  provider: AiProvider;
  model: string;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
}

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigError";
  }
}

/**
 * Validates and resolves the active AI provider, model name, and base URL from the environment.
 * Falls back to current system defaults (`groq` + `openai/gpt-oss-20b`) when variables are unset.
 */
export function resolveAiConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AiModelConfig {
  // 1. Resolve Provider
  const explicitProvider =
    env.AI_PROVIDER?.trim() ||
    env.REMEDIATION_MODEL_PROVIDER?.trim() ||
    env.REMEDIATION_PROVIDER?.trim() ||
    env.AI_MODEL_PROVIDER?.trim();

  let provider: AiProvider = "groq";

  if (explicitProvider) {
    const normalized = explicitProvider.toLowerCase() as AiProvider;
    if (!SUPPORTED_AI_PROVIDERS.includes(normalized)) {
      throw new AiConfigError(
        `Invalid AI provider "${explicitProvider}". Supported providers are: ${SUPPORTED_AI_PROVIDERS.join(", ")}.`,
      );
    }
    provider = normalized;
  } else {
    // Backward compatibility for existing local model variables
    const localProviderEnv = env.LOCAL_AI_PROVIDER?.toLowerCase().trim();
    const vllmUrl = env.VLLM_URL?.trim() || env.VLLM_BASE_URL?.trim();
    const ollamaUrl = env.OLLAMA_URL?.trim() || env.OLLAMA_BASE_URL?.trim();
    const localUrl = env.LOCAL_AI_URL?.trim();

    if (localProviderEnv === "vllm" || vllmUrl) {
      provider = "vllm";
    } else if (localProviderEnv === "ollama" || ollamaUrl) {
      provider = "ollama";
    } else if (localProviderEnv === "custom") {
      provider = "custom";
    } else if (localUrl) {
      if (localUrl.includes(":8000")) {
        provider = "vllm";
      } else if (localUrl.includes(":11434")) {
        provider = "ollama";
      } else {
        provider = "custom";
      }
    }
  }

  // 2. Resolve Model Name
  const rawExplicitModel =
    env.AI_MODEL ?? env.AI_MODEL_NAME ?? env.REMEDIATION_MODEL ?? env.REMEDIATION_MODEL_NAME;

  if (rawExplicitModel !== undefined && rawExplicitModel.trim() === "") {
    throw new AiConfigError(
      "AI_MODEL cannot be empty. Please specify a valid model name or unset the variable to use the default.",
    );
  }

  let model = rawExplicitModel?.trim();

  if (!model) {
    switch (provider) {
      case "groq":
        model = env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL;
        break;
      case "ollama":
        model = env.OLLAMA_MODEL?.trim() || env.LOCAL_AI_MODEL?.trim() || DEFAULT_OLLAMA_MODEL;
        break;
      case "vllm":
        model = env.VLLM_MODEL?.trim() || env.LOCAL_AI_MODEL?.trim() || DEFAULT_VLLM_MODEL;
        break;
      case "openai":
        model = env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
        break;
      case "custom":
        model = env.LOCAL_AI_MODEL?.trim() || DEFAULT_CUSTOM_MODEL;
        break;
    }
  }

  // 3. Resolve Base URL
  const rawExplicitBaseUrl =
    env.AI_BASE_URL?.trim() ||
    env.AI_API_BASE_URL?.trim() ||
    env.REMEDIATION_BASE_URL?.trim() ||
    env.REMEDIATION_MODEL_BASE_URL?.trim();

  let baseUrl: string | undefined = rawExplicitBaseUrl;

  if (!baseUrl) {
    switch (provider) {
      case "groq":
        baseUrl = env.GROQ_BASE_URL?.trim() || undefined;
        break;
      case "ollama":
        baseUrl =
          env.OLLAMA_URL?.trim() ||
          env.OLLAMA_BASE_URL?.trim() ||
          env.LOCAL_AI_URL?.trim() ||
          DEFAULT_OLLAMA_BASE_URL;
        break;
      case "vllm":
        baseUrl =
          env.VLLM_URL?.trim() ||
          env.VLLM_BASE_URL?.trim() ||
          env.LOCAL_AI_URL?.trim() ||
          DEFAULT_VLLM_BASE_URL;
        break;
      case "openai":
        baseUrl = env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL;
        break;
      case "custom":
        baseUrl = env.LOCAL_AI_URL?.trim() || undefined;
        break;
    }
  }

  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error();
      }
    } catch {
      throw new AiConfigError(
        `Invalid AI base URL "${baseUrl}": must be a valid HTTP or HTTPS URL (e.g. http://localhost:11434/v1).`,
      );
    }
    baseUrl = normalizeAiUrl(baseUrl);
  }

  // 4. Resolve API Key
  let apiKey: string | undefined;
  if (provider === "groq") {
    apiKey = env.GROQ_API_KEY?.trim();
  } else if (provider === "openai") {
    apiKey = env.OPENAI_API_KEY?.trim() || env.AI_API_KEY?.trim() || "local";
  } else {
    apiKey = env.LOCAL_AI_API_KEY?.trim() || env.AI_API_KEY?.trim() || "local";
  }

  return {
    provider,
    model,
    baseUrl,
    apiKey,
  };
}

/**
 * Validates the AI model configuration. Throws an `AiConfigError` if invalid,
 * or returns the validated configuration.
 */
export function validateAiConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AiModelConfig {
  return resolveAiConfig(env);
}

/**
 * Returns a human-readable one-line description of the active AI model configuration.
 */
export function describeAiConfig(config: AiModelConfig): string {
  const parts = [`provider=${config.provider}`, `model=${config.model}`];
  if (config.baseUrl) {
    parts.push(`baseUrl=${config.baseUrl}`);
  }
  return parts.join(", ");
}

/**
 * Checks if verbose logging is requested in the environment or command line,
 * and prints the active model configuration if so.
 */
export function logActiveModelIfVerbose(
  config: AiModelConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const isVerbose =
    env.VERBOSE === "true" ||
    env.LOG_LEVEL === "verbose" ||
    env.LOG_LEVEL === "debug" ||
    (typeof process !== "undefined" && process.argv?.includes("--verbose"));

  if (isVerbose) {
    console.log(
      `[AI Startup] Active model for remediation & explanations: ${describeAiConfig(config)}`,
    );
  }
}

/**
 * Validates AI configuration at startup and logs the active model in verbose mode.
 */
export function validateAndLogAiConfigStartup(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AiModelConfig {
  const config = validateAiConfig(env);
  logActiveModelIfVerbose(config, env);
  return config;
}
