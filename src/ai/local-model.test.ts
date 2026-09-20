import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  resolveLocalModelConfig,
  isLocalModelEnabled,
  localModelRef,
  createLocalAiInstance,
  normalizeLocalAiUrl,
  isAirGappedEndpoint,
  pingLocalModel,
  DEFAULT_OLLAMA_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_VLLM_URL,
  DEFAULT_VLLM_MODEL,
  DEFAULT_LOCAL_AI_URL,
  DEFAULT_LOCAL_AI_MODEL,
} from "./local-model";

// ---------------------------------------------------------------------------
// Mock genkit and the compat-oai plugin so tests never touch the network
// ---------------------------------------------------------------------------

vi.mock("genkit", () => ({
  genkit: vi.fn().mockReturnValue({ id: "mock-local-ai-instance" }),
}));

vi.mock("@genkit-ai/compat-oai", () => ({
  openAICompatible: vi.fn().mockReturnValue({ id: "mock-openai-plugin" }),
}));

import { genkit } from "genkit";
import { openAICompatible } from "@genkit-ai/compat-oai";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// normalizeLocalAiUrl
// ---------------------------------------------------------------------------

describe("normalizeLocalAiUrl", () => {
  it("appends /v1 if missing", () => {
    expect(normalizeLocalAiUrl("http://localhost:11434")).toBe("http://localhost:11434/v1");
    expect(normalizeLocalAiUrl("http://localhost:8000")).toBe("http://localhost:8000/v1");
    expect(normalizeLocalAiUrl("http://192.168.1.50:8000")).toBe("http://192.168.1.50:8000/v1");
  });

  it("handles trailing slashes properly", () => {
    expect(normalizeLocalAiUrl("http://localhost:11434/")).toBe("http://localhost:11434/v1");
    expect(normalizeLocalAiUrl("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
  });

  it("leaves already normalized /v1 endpoints intact", () => {
    expect(normalizeLocalAiUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(normalizeLocalAiUrl("http://localhost:8000/v1")).toBe("http://localhost:8000/v1");
  });
});

// ---------------------------------------------------------------------------
// isAirGappedEndpoint
// ---------------------------------------------------------------------------

describe("isAirGappedEndpoint", () => {
  it("identifies localhost and loopback interfaces", () => {
    expect(isAirGappedEndpoint("http://localhost:11434/v1")).toBe(true);
    expect(isAirGappedEndpoint("http://127.0.0.1:8000/v1")).toBe(true);
    expect(isAirGappedEndpoint("http://0.0.0.0:11434/v1")).toBe(true);
    expect(isAirGappedEndpoint("http://[::1]:8000/v1")).toBe(true);
  });

  it("identifies RFC 1918 private subnet ranges and internal domains", () => {
    expect(isAirGappedEndpoint("http://10.0.1.20:8000/v1")).toBe(true);
    expect(isAirGappedEndpoint("http://192.168.1.100:11434/v1")).toBe(true);
    expect(isAirGappedEndpoint("http://172.16.0.5:8000/v1")).toBe(true);
    expect(isAirGappedEndpoint("http://172.31.255.255:8000/v1")).toBe(true);
    expect(isAirGappedEndpoint("http://ollama.internal:11434/v1")).toBe(true);
    expect(isAirGappedEndpoint("http://vllm.corp:8000/v1")).toBe(true);
    expect(isAirGappedEndpoint("http://ai-service.local:8000/v1")).toBe(true);
    expect(isAirGappedEndpoint("http://vllm-cluster.default.svc.cluster.local:8000/v1")).toBe(true);
  });

  it("rejects public internet endpoints", () => {
    expect(isAirGappedEndpoint("https://api.openai.com/v1")).toBe(false);
    expect(isAirGappedEndpoint("https://api.groq.com/openai/v1")).toBe(false);
    expect(isAirGappedEndpoint("https://api.anthropic.com/v1")).toBe(false);
    expect(isAirGappedEndpoint("http://8.8.8.8:8000/v1")).toBe(false);
    expect(isAirGappedEndpoint("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveLocalModelConfig
// ---------------------------------------------------------------------------

describe("resolveLocalModelConfig", () => {
  it("returns null when no local environment variables are set", () => {
    expect(resolveLocalModelConfig({} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it("returns null when LOCAL_AI_URL is an empty string", () => {
    expect(
      resolveLocalModelConfig({ LOCAL_AI_URL: "" } as unknown as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      resolveLocalModelConfig({ LOCAL_AI_URL: "   " } as unknown as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("resolves generic LOCAL_AI_URL and normalizes URL", () => {
    const config = resolveLocalModelConfig({
      LOCAL_AI_URL: "http://localhost:11434",
    } as unknown as NodeJS.ProcessEnv);

    expect(config).toEqual({
      baseUrl: "http://localhost:11434/v1",
      model: DEFAULT_LOCAL_AI_MODEL,
      provider: "ollama",
      apiKey: "local",
    });
  });

  it("resolves dedicated Ollama environment variables (OLLAMA_URL, OLLAMA_MODEL)", () => {
    const config = resolveLocalModelConfig({
      OLLAMA_URL: "http://192.168.1.10:11434",
      OLLAMA_MODEL: "codellama",
    } as unknown as NodeJS.ProcessEnv);

    expect(config).toEqual({
      baseUrl: "http://192.168.1.10:11434/v1",
      model: "codellama",
      provider: "ollama",
      apiKey: "local",
    });
  });

  it("resolves dedicated vLLM environment variables (VLLM_URL, VLLM_MODEL)", () => {
    const config = resolveLocalModelConfig({
      VLLM_URL: "http://10.0.0.5:8000",
      VLLM_MODEL: "Qwen/Qwen2.5-Coder-7B-Instruct",
    } as unknown as NodeJS.ProcessEnv);

    expect(config).toEqual({
      baseUrl: "http://10.0.0.5:8000/v1",
      model: "Qwen/Qwen2.5-Coder-7B-Instruct",
      provider: "vllm",
      apiKey: "local",
    });
  });

  it("resolves LOCAL_AI_PROVIDER=vllm with default vLLM endpoint and model", () => {
    const config = resolveLocalModelConfig({
      LOCAL_AI_PROVIDER: "vllm",
    } as unknown as NodeJS.ProcessEnv);

    expect(config).toEqual({
      baseUrl: DEFAULT_VLLM_URL,
      model: DEFAULT_VLLM_MODEL,
      provider: "vllm",
      apiKey: "local",
    });
  });

  it("resolves LOCAL_AI_PROVIDER=ollama with default Ollama endpoint and model", () => {
    const config = resolveLocalModelConfig({
      LOCAL_AI_PROVIDER: "ollama",
    } as unknown as NodeJS.ProcessEnv);

    expect(config).toEqual({
      baseUrl: DEFAULT_OLLAMA_URL,
      model: DEFAULT_OLLAMA_MODEL,
      provider: "ollama",
      apiKey: "local",
    });
  });

  it("supports custom LOCAL_AI_API_KEY for protected enterprise clusters", () => {
    const config = resolveLocalModelConfig({
      LOCAL_AI_URL: "http://cluster-vllm.corp:8000/v1",
      LOCAL_AI_API_KEY: "secret-token-xyz",
    } as unknown as NodeJS.ProcessEnv);

    expect(config?.apiKey).toBe("secret-token-xyz");
  });

  it("trims whitespace from all variables", () => {
    const config = resolveLocalModelConfig({
      LOCAL_AI_URL: "  http://localhost:11434  ",
      LOCAL_AI_MODEL: "  mistral  ",
      LOCAL_AI_API_KEY: "  key-123  ",
    } as unknown as NodeJS.ProcessEnv);

    expect(config?.baseUrl).toBe("http://localhost:11434/v1");
    expect(config?.model).toBe("mistral");
    expect(config?.apiKey).toBe("key-123");
  });
});

// ---------------------------------------------------------------------------
// isLocalModelEnabled
// ---------------------------------------------------------------------------

describe("isLocalModelEnabled", () => {
  it("returns false when no local settings are present", () => {
    expect(isLocalModelEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("returns true when LOCAL_AI_URL is set", () => {
    expect(
      isLocalModelEnabled({
        LOCAL_AI_URL: "http://localhost:11434/v1",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("returns true when OLLAMA_URL is set", () => {
    expect(
      isLocalModelEnabled({
        OLLAMA_URL: "http://localhost:11434",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("returns true when VLLM_URL is set", () => {
    expect(
      isLocalModelEnabled({
        VLLM_URL: "http://localhost:8000",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("returns true when LOCAL_AI_PROVIDER is set", () => {
    expect(
      isLocalModelEnabled({
        LOCAL_AI_PROVIDER: "ollama",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// localModelRef
// ---------------------------------------------------------------------------

describe("localModelRef", () => {
  it("returns openai/<model> format for Ollama", () => {
    expect(localModelRef({ baseUrl: "http://localhost:11434/v1", model: "llama3" })).toBe(
      "openai/llama3",
    );
  });

  it("returns openai/<model> format for vLLM", () => {
    expect(
      localModelRef({
        baseUrl: "http://localhost:8000/v1",
        model: "meta-llama/Meta-Llama-3-8B-Instruct",
      }),
    ).toBe("openai/meta-llama/Meta-Llama-3-8B-Instruct");
  });
});

// ---------------------------------------------------------------------------
// pingLocalModel
// ---------------------------------------------------------------------------

describe("pingLocalModel", () => {
  it("returns ok=true when endpoint responds successfully", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    } as Response);

    try {
      const res = await pingLocalModel({
        baseUrl: "http://localhost:11434/v1",
        model: "llama3",
        provider: "ollama",
      });

      expect(res.ok).toBe(true);
      expect(res.provider).toBe("ollama");
      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:11434/v1/models",
        expect.objectContaining({
          headers: { Authorization: "Bearer local" },
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("returns ok=false with error description when endpoint fails", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    } as Response);

    try {
      const res = await pingLocalModel({
        baseUrl: "http://localhost:8000/v1",
        model: "llama3",
        provider: "vllm",
      });

      expect(res.ok).toBe(false);
      expect(res.error).toContain("503");
      expect(res.provider).toBe("vllm");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("handles network error or connection timeout cleanly", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));

    try {
      const res = await pingLocalModel({
        baseUrl: "http://localhost:11434/v1",
        model: "llama3",
      });

      expect(res.ok).toBe(false);
      expect(res.error).toContain("ECONNREFUSED");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// createLocalAiInstance
// ---------------------------------------------------------------------------

describe("createLocalAiInstance", () => {
  it("calls genkit() with the OpenAI-compatible plugin", () => {
    createLocalAiInstance({ baseUrl: "http://localhost:11434/v1", model: "llama3" });

    expect(openAICompatible).toHaveBeenCalledOnce();
    expect(openAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "http://localhost:11434/v1" }),
    );
    expect(genkit).toHaveBeenCalledOnce();
  });

  it("uses provided API key or defaults to 'local'", () => {
    createLocalAiInstance({
      baseUrl: "http://localhost:8000/v1",
      model: "mistral",
      apiKey: "custom-token-123",
    });

    const pluginArgs = vi.mocked(openAICompatible).mock.calls[0][0] as { apiKey: string };
    expect(pluginArgs.apiKey).toBe("custom-token-123");
  });

  it("passes the baseURL from config to the plugin", () => {
    const customUrl = "http://10.0.0.5:8000/v1";
    createLocalAiInstance({ baseUrl: customUrl, model: "mistral" });

    const pluginArgs = vi.mocked(openAICompatible).mock.calls[0][0] as { baseURL: string };
    expect(pluginArgs.baseURL).toBe(customUrl);
  });

  it("returns the genkit instance", () => {
    const instance = createLocalAiInstance({
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
    });
    expect(instance).toEqual({ id: "mock-local-ai-instance" });
  });
});

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

describe("default constants", () => {
  it("DEFAULT_OLLAMA_URL points to the standard Ollama port", () => {
    expect(DEFAULT_OLLAMA_URL).toBe("http://localhost:11434/v1");
  });

  it("DEFAULT_OLLAMA_MODEL is llama3", () => {
    expect(DEFAULT_OLLAMA_MODEL).toBe("llama3");
  });

  it("DEFAULT_VLLM_URL points to standard vLLM port 8000", () => {
    expect(DEFAULT_VLLM_URL).toBe("http://localhost:8000/v1");
  });

  it("DEFAULT_VLLM_MODEL is Meta-Llama-3-8B-Instruct", () => {
    expect(DEFAULT_VLLM_MODEL).toBe("meta-llama/Meta-Llama-3-8B-Instruct");
  });
});
