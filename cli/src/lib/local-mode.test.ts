import { describe, expect, it } from "vitest";
import { hostedAiScanSkipReason, localModeEnv } from "./local-mode.js";

describe("hostedAiScanSkipReason", () => {
  it("allows the hosted AI pass by default", () => {
    expect(hostedAiScanSkipReason(["node", "secureflow"])).toBeNull();
  });

  it("skips the upload under --local, so staged code never leaves the machine", () => {
    expect(hostedAiScanSkipReason(["node", "secureflow", "--local"])).toBe("local");
    expect(
      hostedAiScanSkipReason(["node", "secureflow", "--local", "http://localhost:11434/v1"]),
    ).toBe("local");
    expect(
      hostedAiScanSkipReason(["node", "secureflow", "--local", "--local-model", "codellama"]),
    ).toBe("local");
  });

  it("skips the upload under --ollama for air-gapped Ollama execution", () => {
    expect(hostedAiScanSkipReason(["node", "secureflow", "--ollama"])).toBe("local");
    expect(
      hostedAiScanSkipReason(["node", "secureflow", "--ollama=http://127.0.0.1:11434/v1"]),
    ).toBe("local");
    expect(
      hostedAiScanSkipReason(["node", "secureflow", "--ollama", "--ollama-model", "codellama"]),
    ).toBe("local");
  });

  it("skips the upload under --vllm for air-gapped vLLM execution", () => {
    expect(hostedAiScanSkipReason(["node", "secureflow", "--vllm"])).toBe("local");
    expect(hostedAiScanSkipReason(["node", "secureflow", "--vllm=http://localhost:8000/v1"])).toBe(
      "local",
    );
    expect(
      hostedAiScanSkipReason([
        "node",
        "secureflow",
        "--vllm",
        "--vllm-model",
        "meta-llama/Meta-Llama-3-8B-Instruct",
      ]),
    ).toBe("local");
  });

  it("does not treat --local-model alone as --local", () => {
    expect(hostedAiScanSkipReason(["node", "secureflow", "--local-model", "codellama"])).toBeNull();
  });

  it("reports --no-ai when both flags are given", () => {
    expect(hostedAiScanSkipReason(["node", "secureflow", "--local", "--no-ai"])).toBe("no-ai");
    expect(hostedAiScanSkipReason(["node", "secureflow", "--ollama", "--no-ai"])).toBe("no-ai");
    expect(hostedAiScanSkipReason(["node", "secureflow", "--vllm", "--no-ai"])).toBe("no-ai");
  });
});

describe("localModeEnv", () => {
  const argv = (...args: string[]) => ["node", "secureflow", ...args];

  it("sets nothing without a local flag", () => {
    expect(localModeEnv(argv("--format", "json"), {})).toEqual({});
  });

  it("keeps the whole inline URL when it contains its own '='", () => {
    expect(localModeEnv(argv("--ollama=http://gateway:8080/v1?tenant=a"), {})).toEqual({
      LOCAL_AI_PROVIDER: "ollama",
      LOCAL_AI_URL: "http://gateway:8080/v1?tenant=a",
    });
    expect(localModeEnv(argv("--vllm=https://llm.corp/v1?key=abc=="), {})).toMatchObject({
      LOCAL_AI_URL: "https://llm.corp/v1?key=abc==",
    });
  });

  it("reads the URL from the next argument and the provider model flag", () => {
    expect(
      localModeEnv(argv("--vllm", "http://10.0.0.5:8000/v1", "--vllm-model", "mistral"), {}),
    ).toEqual({
      LOCAL_AI_PROVIDER: "vllm",
      LOCAL_AI_URL: "http://10.0.0.5:8000/v1",
      LOCAL_AI_MODEL: "mistral",
    });
  });

  it("defaults to each provider's standard port, after any LOCAL_AI_URL already set", () => {
    expect(localModeEnv(argv("--vllm"), {}).LOCAL_AI_URL).toBe("http://localhost:8000/v1");
    expect(localModeEnv(argv("--ollama"), {}).LOCAL_AI_URL).toBe("http://localhost:11434/v1");
    expect(localModeEnv(argv("--local"), {}).LOCAL_AI_URL).toBe("http://localhost:11434/v1");
    expect(localModeEnv(argv("--local"), { LOCAL_AI_URL: "http://box:1/v1" }).LOCAL_AI_URL).toBe(
      "http://box:1/v1",
    );
  });

  it("does not take a following flag as the URL", () => {
    expect(localModeEnv(argv("--local", "--local-model", "codellama"), {})).toEqual({
      LOCAL_AI_URL: "http://localhost:11434/v1",
      LOCAL_AI_MODEL: "codellama",
    });
  });

  it("lets --local-model override the provider-specific model flag", () => {
    expect(
      localModeEnv(argv("--ollama", "--ollama-model", "llama3", "--local-model", "codellama"), {})
        .LOCAL_AI_MODEL,
    ).toBe("codellama");
  });
});
