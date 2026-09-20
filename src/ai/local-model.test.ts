import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveLocalModelConfig,
  isLocalModelEnabled,
  localModelRef,
  createLocalAiInstance,
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
});

// ---------------------------------------------------------------------------
// resolveLocalModelConfig
// ---------------------------------------------------------------------------

describe("resolveLocalModelConfig", () => {
  it("returns null when LOCAL_AI_URL is not set", () => {
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

  it("returns a config with the provided URL and default model", () => {
    const config = resolveLocalModelConfig({
      LOCAL_AI_URL: "http://localhost:11434/v1",
    } as unknown as NodeJS.ProcessEnv);

    expect(config).toEqual({
      baseUrl: "http://localhost:11434/v1",
      model: DEFAULT_LOCAL_AI_MODEL,
    });
  });

  it("uses LOCAL_AI_MODEL when provided", () => {
    const config = resolveLocalModelConfig({
      LOCAL_AI_URL: "http://localhost:11434/v1",
      LOCAL_AI_MODEL: "codellama",
    } as unknown as NodeJS.ProcessEnv);

    expect(config?.model).toBe("codellama");
  });

  it("trims whitespace from both variables", () => {
    const config = resolveLocalModelConfig({
      LOCAL_AI_URL: "  http://localhost:11434/v1  ",
      LOCAL_AI_MODEL: "  mistral  ",
    } as unknown as NodeJS.ProcessEnv);

    expect(config?.baseUrl).toBe("http://localhost:11434/v1");
    expect(config?.model).toBe("mistral");
  });

  it("accepts a non-default port and path", () => {
    const config = resolveLocalModelConfig({
      LOCAL_AI_URL: "http://192.168.1.10:8080/v1",
    } as unknown as NodeJS.ProcessEnv);
    expect(config?.baseUrl).toBe("http://192.168.1.10:8080/v1");
  });
});

// ---------------------------------------------------------------------------
// isLocalModelEnabled
// ---------------------------------------------------------------------------

describe("isLocalModelEnabled", () => {
  it("returns false when LOCAL_AI_URL is absent", () => {
    expect(isLocalModelEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("returns true when LOCAL_AI_URL is set", () => {
    expect(
      isLocalModelEnabled({
        LOCAL_AI_URL: "http://localhost:11434/v1",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("returns false for a blank LOCAL_AI_URL", () => {
    expect(isLocalModelEnabled({ LOCAL_AI_URL: "" } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// localModelRef
// ---------------------------------------------------------------------------

describe("localModelRef", () => {
  it("returns openai/<model> format", () => {
    expect(localModelRef({ baseUrl: "http://localhost:11434/v1", model: "llama3" })).toBe(
      "openai/llama3",
    );
  });

  it("uses the model name from config, not a hardcoded default", () => {
    expect(localModelRef({ baseUrl: "http://localhost:11434/v1", model: "codellama" })).toBe(
      "openai/codellama",
    );
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

  it("uses a placeholder API key (not a real credential)", () => {
    createLocalAiInstance({ baseUrl: "http://localhost:11434/v1", model: "llama3" });

    const pluginArgs = vi.mocked(openAICompatible).mock.calls[0][0] as { apiKey: string };
    // Must be a non-empty placeholder, not a real key pattern
    expect(pluginArgs.apiKey).toBe("local");
  });

  it("passes the baseURL from config to the plugin", () => {
    const customUrl = "http://10.0.0.5:11434/v1";
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
// Integration: DEFAULT constants
// ---------------------------------------------------------------------------

describe("default constants", () => {
  it("DEFAULT_LOCAL_AI_URL points to the standard Ollama port", () => {
    expect(DEFAULT_LOCAL_AI_URL).toBe("http://localhost:11434/v1");
  });

  it("DEFAULT_LOCAL_AI_MODEL is llama3", () => {
    expect(DEFAULT_LOCAL_AI_MODEL).toBe("llama3");
  });
});
