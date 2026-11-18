import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveAiConfig,
  validateAiConfig,
  describeAiConfig,
  logActiveModelIfVerbose,
  validateAndLogAiConfigStartup,
  AiConfigError,
  DEFAULT_GROQ_MODEL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_VLLM_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_CUSTOM_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_VLLM_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
} from "./model-config";

describe("src/ai/model-config.ts (Configurable Remediation & Explanation Models)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AI_PROVIDER;
    delete process.env.AI_MODEL;
    delete process.env.AI_MODEL_NAME;
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_BASE_URL;
    delete process.env.REMEDIATION_PROVIDER;
    delete process.env.REMEDIATION_MODEL_PROVIDER;
    delete process.env.REMEDIATION_MODEL;
    delete process.env.REMEDIATION_MODEL_NAME;
    delete process.env.REMEDIATION_BASE_URL;
    delete process.env.REMEDIATION_MODEL_BASE_URL;
    delete process.env.GROQ_MODEL;
    delete process.env.GROQ_BASE_URL;
    delete process.env.LOCAL_AI_URL;
    delete process.env.LOCAL_AI_MODEL;
    delete process.env.LOCAL_AI_PROVIDER;
    delete process.env.OLLAMA_URL;
    delete process.env.OLLAMA_MODEL;
    delete process.env.VLLM_URL;
    delete process.env.VLLM_MODEL;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe("resolveAiConfig defaults & backward compatibility", () => {
    it("defaults to groq provider and openai/gpt-oss-20b when no variables are set", () => {
      const config = resolveAiConfig({});
      expect(config.provider).toBe("groq");
      expect(config.model).toBe(DEFAULT_GROQ_MODEL);
      expect(config.baseUrl).toBeUndefined();
    });

    it("preserves existing GROQ_MODEL environment variable", () => {
      const config = resolveAiConfig({
        GROQ_MODEL: "openai/gpt-oss-120b",
      });
      expect(config.provider).toBe("groq");
      expect(config.model).toBe("openai/gpt-oss-120b");
      expect(config.baseUrl).toBeUndefined();
    });

    it("preserves existing LOCAL_AI_URL and LOCAL_AI_MODEL settings", () => {
      const config = resolveAiConfig({
        LOCAL_AI_URL: "http://localhost:11434",
        LOCAL_AI_MODEL: "mistral",
      });
      expect(config.provider).toBe("ollama");
      expect(config.model).toBe("mistral");
      expect(config.baseUrl).toBe("http://localhost:11434/v1");
    });

    it("preserves existing VLLM_URL settings", () => {
      const config = resolveAiConfig({
        VLLM_URL: "http://gpu-cluster:8000/v1",
      });
      expect(config.provider).toBe("vllm");
      expect(config.model).toBe(DEFAULT_VLLM_MODEL);
      expect(config.baseUrl).toBe("http://gpu-cluster:8000/v1");
    });
  });

  describe("Custom Model & Provider Configuration", () => {
    it("allows switching model name without editing code", () => {
      const config = resolveAiConfig({
        AI_MODEL: "llama-3.3-70b-versatile",
      });
      expect(config.provider).toBe("groq");
      expect(config.model).toBe("llama-3.3-70b-versatile");
    });

    it("allows configuring Ollama provider, model, and custom base URL", () => {
      const config = resolveAiConfig({
        AI_PROVIDER: "ollama",
        AI_MODEL: "codellama:13b",
        AI_BASE_URL: "http://on-prem-ollama:11434",
      });
      expect(config.provider).toBe("ollama");
      expect(config.model).toBe("codellama:13b");
      expect(config.baseUrl).toBe("http://on-prem-ollama:11434/v1");
    });

    it("allows configuring vLLM provider with defaults", () => {
      const config = resolveAiConfig({
        AI_PROVIDER: "vllm",
      });
      expect(config.provider).toBe("vllm");
      expect(config.model).toBe(DEFAULT_VLLM_MODEL);
      expect(config.baseUrl).toBe(DEFAULT_VLLM_BASE_URL);
    });

    it("allows configuring OpenAI provider with defaults", () => {
      const config = resolveAiConfig({
        AI_PROVIDER: "openai",
      });
      expect(config.provider).toBe("openai");
      expect(config.model).toBe(DEFAULT_OPENAI_MODEL);
      expect(config.baseUrl).toBe(DEFAULT_OPENAI_BASE_URL);
    });

    it("allows configuring custom provider and model", () => {
      const config = resolveAiConfig({
        AI_PROVIDER: "custom",
        AI_MODEL: "my-fine-tuned-model",
        AI_BASE_URL: "https://llm.corp.internal/v1",
      });
      expect(config.provider).toBe("custom");
      expect(config.model).toBe("my-fine-tuned-model");
      expect(config.baseUrl).toBe("https://llm.corp.internal/v1");
    });

    it("supports REMEDIATION_* aliases", () => {
      const config = resolveAiConfig({
        REMEDIATION_PROVIDER: "ollama",
        REMEDIATION_MODEL: "qwen2.5-coder:7b",
        REMEDIATION_BASE_URL: "http://127.0.0.1:11434",
      });
      expect(config.provider).toBe("ollama");
      expect(config.model).toBe("qwen2.5-coder:7b");
      expect(config.baseUrl).toBe("http://127.0.0.1:11434/v1");
    });
  });

  describe("Validation & Error Messages", () => {
    it("rejects unknown AI provider with clear descriptive error message", () => {
      expect(() => {
        validateAiConfig({ AI_PROVIDER: "unsupported-cloud" });
      }).toThrowError(
        /Invalid AI provider "unsupported-cloud"\. Supported providers are: groq, ollama, vllm, openai, custom\./,
      );
    });

    it("rejects empty or whitespace-only AI_MODEL", () => {
      expect(() => {
        validateAiConfig({ AI_MODEL: "" });
      }).toThrowError(/AI_MODEL cannot be empty/);

      expect(() => {
        validateAiConfig({ AI_MODEL: "   " });
      }).toThrowError(/AI_MODEL cannot be empty/);
    });

    it("rejects malformed AI_BASE_URL with clear descriptive error message", () => {
      expect(() => {
        validateAiConfig({ AI_BASE_URL: "not-a-valid-url" });
      }).toThrowError(/Invalid AI base URL "not-a-valid-url": must be a valid HTTP or HTTPS URL/);

      expect(() => {
        validateAiConfig({ AI_BASE_URL: "ftp://storage.server/v1" });
      }).toThrowError(/Invalid AI base URL "ftp:\/\/storage\.server\/v1"/);
    });
  });

  describe("Verbose Mode Logging", () => {
    it("formats describeAiConfig accurately", () => {
      const config = {
        provider: "ollama" as const,
        model: "llama3",
        baseUrl: "http://localhost:11434/v1",
      };
      expect(describeAiConfig(config)).toBe(
        "provider=ollama, model=llama3, baseUrl=http://localhost:11434/v1",
      );

      const groqConfig = {
        provider: "groq" as const,
        model: "openai/gpt-oss-20b",
      };
      expect(describeAiConfig(groqConfig)).toBe("provider=groq, model=openai/gpt-oss-20b");
    });

    it("logs active model when VERBOSE=true or LOG_LEVEL=verbose", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});

      logActiveModelIfVerbose(
        { provider: "groq", model: "openai/gpt-oss-20b" },
        { VERBOSE: "true" },
      );
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[AI Startup] Active model for remediation & explanations: provider=groq, model=openai/gpt-oss-20b",
        ),
      );

      spy.mockClear();
      logActiveModelIfVerbose(
        { provider: "ollama", model: "codellama", baseUrl: "http://localhost:11434/v1" },
        { LOG_LEVEL: "verbose" },
      );
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining(
          "provider=ollama, model=codellama, baseUrl=http://localhost:11434/v1",
        ),
      );

      spy.mockClear();
      logActiveModelIfVerbose(
        { provider: "groq", model: "openai/gpt-oss-20b" },
        { LOG_LEVEL: "info" }, // non-verbose
      );
      expect(spy).not.toHaveBeenCalled();
    });

    it("validates and logs startup in validateAndLogAiConfigStartup", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});

      const config = validateAndLogAiConfigStartup({
        AI_PROVIDER: "ollama",
        AI_MODEL: "llama3",
        VERBOSE: "true",
      });

      expect(config.provider).toBe("ollama");
      expect(config.model).toBe("llama3");
      expect(spy).toHaveBeenCalled();
    });
  });
});
