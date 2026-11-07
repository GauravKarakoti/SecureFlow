import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  default: {
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  },
}));

import {
  isNonInteractiveCiEnvironment,
  getOsAudioCommand,
  playAudioFile,
  cleanupTempFile,
  fetchAudioSummary,
  playVoiceDebrief,
} from "./audio-player.js";

describe("cli/src/lib/audio-player", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    spawnSyncMock.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("isNonInteractiveCiEnvironment", () => {
    it("detects CI environment flags correctly", () => {
      expect(isNonInteractiveCiEnvironment({ CI: "true" })).toBe(true);
      expect(isNonInteractiveCiEnvironment({ CI: "1" })).toBe(true);
      expect(isNonInteractiveCiEnvironment({ GITHUB_ACTIONS: "true" })).toBe(true);
      expect(isNonInteractiveCiEnvironment({ GITLAB_CI: "1" })).toBe(true);
      expect(isNonInteractiveCiEnvironment({ CIRCLECI: "true" })).toBe(true);
      expect(isNonInteractiveCiEnvironment({ TRAVIS: "true" })).toBe(true);
      expect(isNonInteractiveCiEnvironment({ CONTINUOUS_INTEGRATION: "true" })).toBe(true);
      expect(isNonInteractiveCiEnvironment({ BUILDKITE: "true" })).toBe(true);
      expect(isNonInteractiveCiEnvironment({ DOCKER: "true" })).toBe(true);
      expect(isNonInteractiveCiEnvironment({ DOCKER_CONTAINER: "true" })).toBe(true);
      expect(isNonInteractiveCiEnvironment({ container: "docker" })).toBe(true);
    });

    it("returns false in interactive developer environments", () => {
      expect(isNonInteractiveCiEnvironment({})).toBe(false);
      expect(isNonInteractiveCiEnvironment({ CI: "false", GITHUB_ACTIONS: "" })).toBe(false);
    });
  });

  describe("getOsAudioCommand", () => {
    it("returns afplay command for darwin", () => {
      const cmd = getOsAudioCommand("/path/to/test.mp3", "darwin");
      expect(cmd).toEqual({ command: "afplay", args: ["/path/to/test.mp3"] });
    });

    it("returns powershell command for win32", () => {
      const cmd = getOsAudioCommand("C:\\temp\\test.mp3", "win32");
      expect(cmd?.command).toBe("powershell");
      expect(cmd?.args[0]).toBe("-NoProfile");
      expect(cmd?.args[3]).toContain("System.Windows.Media.MediaPlayer");
    });

    it("returns mpg123 command for linux", () => {
      const cmd = getOsAudioCommand("/tmp/test.mp3", "linux");
      expect(cmd).toEqual({ command: "mpg123", args: ["-q", "/tmp/test.mp3"] });
    });

    it("returns null for unsupported platforms", () => {
      const cmd = getOsAudioCommand("/tmp/test.mp3", "aix" as NodeJS.Platform);
      expect(cmd).toBeNull();
    });
  });

  describe("playAudioFile", () => {
    it("bypasses playback in CI environments", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const result = playAudioFile("test.mp3", {
        env: { CI: "true" },
        verbose: true,
      });

      expect(result).toEqual({ played: false, bypassed: true });
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Audio playback bypassed in non-interactive CI environment"),
      );
    });

    it("returns played: true when spawnSync succeeds with exit code 0", () => {
      spawnSyncMock.mockReturnValueOnce({
        status: 0,
        signal: null,
        output: [],
        pid: 1234,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });

      const result = playAudioFile("test.mp3", {
        platform: "darwin",
        env: { CI: "false" },
      });

      expect(result).toEqual({ played: true });
      expect(spawnSyncMock).toHaveBeenCalledWith("afplay", ["test.mp3"], expect.any(Object));
    });

    it("falls back to saving audio file when player fails or command is missing", () => {
      spawnSyncMock.mockReturnValueOnce({
        status: 1,
        signal: null,
        output: [],
        pid: 1234,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });
      const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const tempDir = os.tmpdir();
      const srcFile = path.join(tempDir, "input.mp3");
      const result = playAudioFile(srcFile, {
        platform: "linux",
        env: { CI: "false" },
        fallbackDir: tempDir,
      });

      const expectedFallback = path.join(tempDir, "secureflow-summary.mp3");
      expect(copySpy).toHaveBeenCalledWith(srcFile, expectedFallback);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Audio player unavailable. Summary saved to"),
      );
      expect(result).toEqual({ played: false, savedPath: expectedFallback });
    });

    it("returns error message when copyFileSync fails during fallback", () => {
      spawnSyncMock.mockReturnValueOnce({
        status: 127,
        signal: null,
        output: [],
        pid: 1234,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });
      vi.spyOn(fs, "copyFileSync").mockImplementation(() => {
        throw new Error("Disk full permission denied");
      });

      const result = playAudioFile("/tmp/nonexistent.mp3", {
        platform: "linux",
        env: { CI: "false" },
        fallbackDir: "/readonly/dir",
      });

      expect(result.played).toBe(false);
      expect(result.error).toContain("Disk full permission denied");
    });
  });

  describe("cleanupTempFile", () => {
    it("deletes file when it exists and returns true", () => {
      vi.spyOn(fs, "existsSync").mockReturnValueOnce(true);
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {});

      const deleted = cleanupTempFile("/tmp/test.mp3");
      expect(deleted).toBe(true);
      expect(unlinkSpy).toHaveBeenCalledWith("/tmp/test.mp3");
    });

    it("returns false when file does not exist", () => {
      vi.spyOn(fs, "existsSync").mockReturnValueOnce(false);
      const unlinkSpy = vi.spyOn(fs, "unlinkSync");

      const deleted = cleanupTempFile("/tmp/nonexistent.mp3");
      expect(deleted).toBe(false);
      expect(unlinkSpy).not.toHaveBeenCalled();
    });

    it("returns false when unlinkSync throws an error", () => {
      vi.spyOn(fs, "existsSync").mockReturnValueOnce(true);
      vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
        throw new Error("EPERM: operation not permitted");
      });

      const deleted = cleanupTempFile("/tmp/locked.mp3");
      expect(deleted).toBe(false);
    });
  });

  describe("fetchAudioSummary", () => {
    it("fetches directly from ElevenLabs when API key is provided and valid", async () => {
      const mockAudioBytes = Buffer.from("audio-stream-bytes");
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(mockAudioBytes, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const buffer = await fetchAudioSummary("Test summary text", {
        env: {
          ELEVENLABS_API_KEY: "test-elevenlabs-key",
          ELEVENLABS_VOICE_ID: "custom-voice-id",
        },
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.elevenlabs.io/v1/text-to-speech/custom-voice-id",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "xi-api-key": "test-elevenlabs-key" }),
        }),
      );
      expect(buffer).toEqual(mockAudioBytes);
    });

    it("falls back to /api/cli/scan when ElevenLabs returns error or fails", async () => {
      const mockAudioBytes = Buffer.from("api-scan-audio-bytes");
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network timeout"))
        .mockResolvedValueOnce(
          new Response(mockAudioBytes, {
            status: 200,
            headers: { "Content-Type": "audio/mpeg" },
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const buffer = await fetchAudioSummary("Test summary", {
        baseUrl: "https://secureflow.test",
        env: { ELEVENLABS_API_KEY: "api-key" },
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "https://secureflow.test/api/cli/scan",
        expect.objectContaining({ method: "POST" }),
      );
      expect(buffer).toEqual(mockAudioBytes);
    });

    it("honours the declared `audio` fallback field in the scan response", async () => {
      const mockAudioBytes = Buffer.from("fallback-field-audio");
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ audio: mockAudioBytes.toString("base64") }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const buffer = await fetchAudioSummary("Test summary", {
        baseUrl: "https://secureflow.test",
        env: {},
      });

      expect(buffer).toEqual(mockAudioBytes);
    });

    it("logs warning on ElevenLabs 429 rate limit quota exhaustion", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ detail: { status: "quota_exceeded" } }), {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockRejectedValueOnce(new Error("scan failed"));
      vi.stubGlobal("fetch", fetchMock);

      await fetchAudioSummary("Test quota", {
        env: { ELEVENLABS_API_KEY: "key" },
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ElevenLabs rate limit reached (429 Too Many Requests)"),
      );
    });

    it("logs warning on ElevenLabs 401 unauthorized", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ detail: "invalid_api_key" }), {
            status: 401,
            statusText: "Unauthorized",
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockRejectedValueOnce(new Error("scan failed"));
      vi.stubGlobal("fetch", fetchMock);

      await fetchAudioSummary("Test unauth", {
        env: { ELEVENLABS_API_KEY: "bad-key" },
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ElevenLabs authentication failed (401 Unauthorized)"),
      );
    });

    it("parses base64 audio response from /api/cli/scan JSON payload", async () => {
      const rawString = "base64-encoded-audio";
      const base64Data = Buffer.from(rawString).toString("base64");
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ audioBase64: base64Data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const buffer = await fetchAudioSummary("Test summary", {
        baseUrl: "http://localhost:3000",
        env: {},
      });

      expect(buffer?.toString()).toBe(rawString);
    });

    it("returns null when all audio fetch sources fail", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("All endpoints down"));
      vi.stubGlobal("fetch", fetchMock);

      const buffer = await fetchAudioSummary("Test summary", {
        env: {},
      });

      expect(buffer).toBeNull();
    });
  });

  describe("playVoiceDebrief", () => {
    it("bypasses in CI environment without writing files or calling players", async () => {
      const writeSpy = vi.spyOn(fs, "writeFileSync");
      const result = await playVoiceDebrief("Summary", {
        env: { CI: "true" },
        verbose: true,
      });

      expect(result).toEqual({ played: false, bypassed: true });
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it("writes synthesized audio to temp file, plays it, and cleans up the temp file", async () => {
      const testAudio = Buffer.from("synthesized-audio-content");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(
          new Response(testAudio, {
            status: 200,
            headers: { "Content-Type": "audio/mpeg" },
          }),
        ),
      );

      let capturedTempPath = "";
      vi.spyOn(fs, "writeFileSync").mockImplementation((p) => {
        capturedTempPath = String(p);
      });
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});
      spawnSyncMock.mockReturnValueOnce({
        status: 0,
        signal: null,
        output: [],
        pid: 999,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });

      const result = await playVoiceDebrief("Summary text", {
        platform: "darwin",
        env: { CI: "false", ELEVENLABS_API_KEY: "key" },
      });

      expect(result).toEqual({ played: true });
      expect(capturedTempPath).toContain("secureflow-summary-");
      expect(unlinkSpy).toHaveBeenCalledWith(capturedTempPath);
    });

    it("uses fallback silent frames and still cleans up temp file when audio fetch fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Offline")));

      let capturedBuffer: Buffer | null = null;
      let capturedTempPath = "";
      vi.spyOn(fs, "writeFileSync").mockImplementation((p, data) => {
        capturedTempPath = String(p);
        if (Buffer.isBuffer(data)) {
          capturedBuffer = data;
        }
      });
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});
      spawnSyncMock.mockReturnValueOnce({
        status: 0,
        signal: null,
        output: [],
        pid: 1000,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });

      const result = await playVoiceDebrief("Summary fallback", {
        platform: "linux",
        env: { CI: "false" },
      });

      expect(result).toEqual({ played: true });
      expect(capturedBuffer).not.toBeNull();
      expect(capturedBuffer!.subarray(0, 3).toString()).toBe("ID3");
      expect(unlinkSpy).toHaveBeenCalledWith(capturedTempPath);
    });

    it("preserves temp file when keepTempFile is true", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Offline")));
      vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
      spawnSyncMock.mockReturnValueOnce({
        status: 0,
        signal: null,
        output: [],
        pid: 1001,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });
      const unlinkSpy = vi.spyOn(fs, "unlinkSync");

      await playVoiceDebrief("Summary keep file", {
        platform: "linux",
        env: { CI: "false" },
        keepTempFile: true,
      });

      expect(unlinkSpy).not.toHaveBeenCalled();
    });
  });
});
