import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCreate, resetMockCreate } from "../../../__mocks__/groq-sdk";
import type { LifeSavingAction } from "@/lib/emergency-intake/schemas";
import { LifeSavingActionValidationError } from "@/lib/emergency-intake/schemas";
import {
  validateLifeSavingAction,
  runEmergencyIntakePipeline,
} from "@/lib/emergency-intake/orchestrator";
import {
  buildEmergencyIntakeSystemPrompt,
  buildEmergencyIntakeUserPrompt,
} from "@/lib/emergency-intake/prompts";
import type { EmergencyMedia } from "@/lib/emergency-intake/prompts";

const VALID_ACTION: LifeSavingAction = {
  action: "LOCKDOWN",
  target: "Hospital_DB",
  confidence: 0.99,
  rationale: "Confirmed active shooter near the main entrance.",
  sourceInputs: ["text", "audio"],
  metadata: {},
};

const threatIntelMock = vi.hoisted(() => vi.fn());

vi.mock("../../../packages/cli/src/threat-intel", () => ({
  queryLiveThreatIntelligence: threatIntelMock,
}));

beforeEach(() => {
  vi.stubEnv("GROQ_API_KEY", "mock_test_key");
  resetMockCreate();
  threatIntelMock.mockResolvedValue(
    "[Threat Intelligence Advisory - SEC-LEAK-001 (HIGH)]\nCategory: Secret Logging\nGuidance: Mask secrets prior to logging.",
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  threatIntelMock.mockReset();
});

describe("validateLifeSavingAction", () => {
  it("accepts a valid lockdown action", () => {
    const action = validateLifeSavingAction(VALID_ACTION);
    expect(action.action).toBe("LOCKDOWN");
    expect(action.confidence).toBe(0.99);
  });

  it("parses a JSON string payload", () => {
    const action = validateLifeSavingAction(JSON.stringify(VALID_ACTION));
    expect(action.target).toBe("Hospital_DB");
  });

  it("rejects missing required fields", () => {
    expect(() =>
      validateLifeSavingAction({ action: "LOCKDOWN", target: "X", metadata: {} }),
    ).toThrow(LifeSavingActionValidationError);
  });

  it("rejects confidence outside [0, 1]", () => {
    expect(() => validateLifeSavingAction({ ...VALID_ACTION, confidence: 1.5 })).toThrow(
      LifeSavingActionValidationError,
    );
  });

  it("rejects unsafe target paths", () => {
    expect(() => validateLifeSavingAction({ ...VALID_ACTION, target: "../../etc/passwd" })).toThrow(
      LifeSavingActionValidationError,
    );
  });

  it("rejects unknown extra fields (strict mode)", () => {
    expect(() => validateLifeSavingAction({ ...VALID_ACTION, injected: "nope" })).toThrow(
      LifeSavingActionValidationError,
    );
  });

  it("rejects invalid JSON string", () => {
    expect(() => validateLifeSavingAction("not json {{{")).toThrow(LifeSavingActionValidationError);
  });
});

describe("prompts", () => {
  it("system prompt enforces strict JSON output contract", () => {
    const prompt = buildEmergencyIntakeSystemPrompt();
    expect(prompt).toContain("Respond ONLY with a valid JSON object");
    expect(prompt).toContain("LOCKDOWN");
    expect(prompt).toContain("confidence");
    expect(prompt).toContain("Never emit keys outside the schema");
  });

  it("user prompt includes text and media markers", () => {
    const media: EmergencyMedia[] = [
      { kind: "audio", mimeType: "audio/wav", base64: "UklGRi..." },
      { kind: "image", mimeType: "image/jpeg", base64: "/9j/4..." },
    ];
    const prompt = buildEmergencyIntakeUserPrompt(
      { text: "fire at sector 7", hasAudio: true, hasImage: true },
      media,
    );
    expect(prompt).toContain("fire at sector 7");
    expect(prompt).toContain("VOICE NOTE (audio)");
    expect(prompt).toContain("INCIDENT PHOTO (image)");
    expect(prompt).toContain("data:audio/wav;base64,");
    expect(prompt).toContain("data:image/jpeg;base64,");
  });

  it("user prompt handles missing inputs gracefully", () => {
    const prompt = buildEmergencyIntakeUserPrompt(
      { text: "", hasAudio: false, hasImage: false },
      [],
    );
    expect(prompt).toContain("No inputs provided.");
  });
});

describe("runEmergencyIntakePipeline", () => {
  it("returns a validated LifeSavingAction from Groq output", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(VALID_ACTION) } }],
    });

    const action = await runEmergencyIntakePipeline(
      { text: "fire at sector 7", hasAudio: true, hasImage: false },
      { audio: Buffer.from("fake-audio-bytes") },
    );

    expect(action.action).toBe("LOCKDOWN");
    expect(action.target).toBe("Hospital_DB");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.response_format).toEqual({ type: "json_object" });
    expect(Array.isArray(callArgs.messages[1].content)).toBe(true);
    expect(threatIntelMock).toHaveBeenCalled();
  });

  it("folds threat intelligence context into the user prompt", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(VALID_ACTION) } }],
    });

    await runEmergencyIntakePipeline(
      { text: "CVE-2023-3409 sql injection", hasAudio: false, hasImage: false },
      {},
    );

    const userContent = mockCreate.mock.calls[0][0].messages[1].content;
    const userText = (userContent as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(userText).toContain("THREAT INTELLIGENCE CONTEXT");
    expect(userText).toContain("SEC-LEAK-001");
  });

  it("degrades gracefully when threat intel is unavailable", async () => {
    threatIntelMock.mockRejectedValue(new Error("MCP down"));
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(VALID_ACTION) } }],
    });

    const action = await runEmergencyIntakePipeline(
      { text: "garbled logs", hasAudio: false, hasImage: false },
      {},
    );
    expect(action.action).toBe("LOCKDOWN");
  });

  it("throws when Groq returns invalid JSON", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "not valid json {{{" } }],
    });

    await expect(
      runEmergencyIntakePipeline({ text: "garbled logs", hasAudio: false, hasImage: false }, {}),
    ).rejects.toThrow(LifeSavingActionValidationError);
  });

  it("throws when Groq output fails schema validation", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ action: "BOGUS" }) } }],
    });

    await expect(
      runEmergencyIntakePipeline({ text: "garbled logs", hasAudio: false, hasImage: false }, {}),
    ).rejects.toThrow(LifeSavingActionValidationError);
  });

  it("embeds image as base64 data URI when provided", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(VALID_ACTION) } }],
    });

    await runEmergencyIntakePipeline(
      { text: "", hasAudio: false, hasImage: true },
      { image: Buffer.from("fake-image-bytes") },
    );

    const content = mockCreate.mock.calls[0][0].messages[1].content as Array<{
      type: string;
      image_url?: { url: string };
    }>;
    const imagePart = content.find((p) => p.type === "image_url");
    expect(imagePart).toBeDefined();
    expect(imagePart?.image_url?.url).toContain("data:image/jpeg;base64,");
  });
});
