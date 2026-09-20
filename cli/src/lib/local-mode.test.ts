import { describe, expect, it } from "vitest";
import { hostedAiScanSkipReason } from "./local-mode.js";

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
    expect(
      hostedAiScanSkipReason(["node", "secureflow", "--vllm=http://localhost:8000/v1"]),
    ).toBe("local");
    expect(
      hostedAiScanSkipReason(["node", "secureflow", "--vllm", "--vllm-model", "meta-llama/Meta-Llama-3-8B-Instruct"]),
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
