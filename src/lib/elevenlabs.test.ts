import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));

vi.mock("@elevenlabs/elevenlabs-js", () => ({
  ElevenLabsClient: class {
    textToSpeech = { stream: streamMock };
  },
}));

describe("elevenlabs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.ELEVENLABS_API_KEY = "test-key";
    process.env.ELEVENLABS_VOICE_ID_DEFAULT = "voice-default";
    process.env.ELEVENLABS_VOICE_ID_ALERT = "voice-alert";
    delete process.env.ELEVENLABS_VOICE_ID_HEIST;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws when API key is missing", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const { getElevenLabsClient } = await import("./elevenlabs");
    expect(() => getElevenLabsClient()).toThrow("ELEVENLABS_API_KEY");
  });

  it("returns the same client instance (singleton)", async () => {
    const { getElevenLabsClient } = await import("./elevenlabs");
    expect(getElevenLabsClient()).toBe(getElevenLabsClient());
  });

  it("resolves voice ids per persona and throws if missing", async () => {
    const { resolveVoiceId } = await import("./elevenlabs");
    expect(resolveVoiceId("default")).toBe("voice-default");
    expect(resolveVoiceId("alert")).toBe("voice-alert");
    expect(() => resolveVoiceId("heist")).toThrow("heist");
  });

  it("retries on 429 and then succeeds", async () => {
    vi.useFakeTimers();
    streamMock.mockRejectedValueOnce({ statusCode: 429 }).mockResolvedValueOnce("stream-ok");
    const { streamSpeech } = await import("./elevenlabs");
    const promise = streamSpeech("hello", { persona: "default" });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBe("stream-ok");
    expect(streamMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-429 errors", async () => {
    streamMock.mockRejectedValue({ statusCode: 500 });
    const { streamSpeech } = await import("./elevenlabs");
    await expect(streamSpeech("hello")).rejects.toEqual({ statusCode: 500 });
    expect(streamMock).toHaveBeenCalledTimes(1);
  });
});
