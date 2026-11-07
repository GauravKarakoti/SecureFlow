import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import type { StagedFileForAiScan } from "./api-client.js";

const DEFAULT_BASE_URL = "https://secure-flow-six.vercel.app";

export interface AudioPlaybackResult {
  played: boolean;
  bypassed?: boolean;
  savedPath?: string;
  error?: string;
}

export type AudioPlayerEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * Checks if the current process is running in a non-interactive CI/CD environment.
 */
export function isNonInteractiveCiEnvironment(env: AudioPlayerEnv = process.env): boolean {
  return Boolean(
    env.CI === "true" ||
    env.CI === "1" ||
    env.GITHUB_ACTIONS === "true" ||
    env.GITLAB_CI ||
    env.CIRCLECI ||
    env.TRAVIS ||
    env.CONTINUOUS_INTEGRATION ||
    env.BUILDKITE ||
    env.DOCKER === "true" ||
    env.DOCKER_CONTAINER === "true" ||
    env.container === "docker",
  );
}

/**
 * Determines the command and arguments for native OS audio playback.
 */
export function getOsAudioCommand(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } | null {
  switch (platform) {
    case "darwin":
      return { command: "afplay", args: [filePath] };
    case "win32": {
      // PowerShell sound player: uses SoundPlayer for .wav or MediaPlayer / wmplayer fallback
      const psScript = `
        try {
          Add-Type -AssemblyName presentationCore;
          $player = New-Object System.Windows.Media.MediaPlayer;
          $player.Open([System.Uri]'${filePath.replace(/'/g, "''")}');
          $player.Play();
          Start-Sleep -Seconds 1;
        } catch {
          [System.Media.SystemSounds]::Beep.Play();
        }
      `
        .replace(/\s+/g, " ")
        .trim();
      return {
        command: "powershell",
        args: ["-NoProfile", "-NonInteractive", "-Command", psScript],
      };
    }
    case "linux":
      // Supports mpg123, aplay, paplay
      return { command: "mpg123", args: ["-q", filePath] };
    default:
      return null;
  }
}

/**
 * Attempts to play an audio file through OS native tools, or saves the file as fallback.
 */
export function playAudioFile(
  filePath: string,
  options?: {
    platform?: NodeJS.Platform;
    env?: AudioPlayerEnv;
    verbose?: boolean;
    fallbackDir?: string;
  },
): AudioPlaybackResult {
  const env = options?.env ?? process.env;
  if (isNonInteractiveCiEnvironment(env)) {
    if (options?.verbose) {
      console.log("ℹ️  [SecureFlow] Audio playback bypassed in non-interactive CI environment.");
    }
    return { played: false, bypassed: true };
  }

  const platform = options?.platform ?? process.platform;
  const cmd = getOsAudioCommand(filePath, platform);

  if (cmd) {
    try {
      const result = spawnSync(cmd.command, cmd.args, {
        stdio: "ignore",
        timeout: 10000,
      });

      if (result.status === 0) {
        return { played: true };
      }
    } catch {
      // Audio tool failed or command not found, proceed to fallback
    }
  }

  // Fallback: save to a permanent file location if requested or in cwd
  const fallbackDir = options?.fallbackDir ?? process.cwd();
  const fallbackPath = path.join(fallbackDir, "secureflow-summary.mp3");

  try {
    if (path.resolve(filePath) !== path.resolve(fallbackPath)) {
      fs.copyFileSync(filePath, fallbackPath);
    }
    console.log(`🔊 [SecureFlow] Audio player unavailable. Summary saved to ${fallbackPath}`);
    return { played: false, savedPath: fallbackPath };
  } catch (err) {
    return { played: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetches audio summary buffer from ElevenLabs directly or /api/cli/scan endpoint.
 */
export async function fetchAudioSummary(
  summaryText: string,
  options?: {
    baseUrl?: string;
    files?: StagedFileForAiScan[];
    env?: AudioPlayerEnv;
  },
): Promise<Buffer | null> {
  const env = options?.env ?? process.env;
  const elevenLabsApiKey = env.ELEVENLABS_API_KEY;

  // 1. Direct ElevenLabs Client API if local key is provided
  if (elevenLabsApiKey && elevenLabsApiKey.trim().length > 0) {
    try {
      const voiceId = env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // default voice
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": elevenLabsApiKey,
        },
        body: JSON.stringify({
          text: summaryText,
          model_id: "eleven_monolingual_v1",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      });

      if (response.ok) {
        const arrayBuf = await response.arrayBuffer();
        return Buffer.from(arrayBuf);
      }

      if (response.status === 429) {
        console.warn("⚠️  [SecureFlow] ElevenLabs rate limit reached (429 Too Many Requests).");
      } else if (response.status === 401) {
        console.warn(
          "⚠️  [SecureFlow] ElevenLabs authentication failed (401 Unauthorized). Check API key.",
        );
      }
    } catch {
      // Fallback to /api/cli/scan
    }
  }

  // 2. Fetch from /api/cli/scan
  try {
    const baseUrl = options?.baseUrl || DEFAULT_BASE_URL;
    const response = await fetch(`${baseUrl}/api/cli/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: options?.files || [],
        voice: true,
        summaryText,
      }),
    });

    if (response.ok) {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("audio")) {
        const arrayBuf = await response.arrayBuffer();
        return Buffer.from(arrayBuf);
      }

      const data = (await response.json()) as { audioBase64?: string; audio?: string };
      // Both field names are part of the declared response contract; a server
      // sending only `audio` previously degraded to the silent stub.
      const encoded = data.audioBase64 ?? data.audio;
      if (encoded) {
        return Buffer.from(encoded, "base64");
      }
    }
  } catch {
    // Graceful degradation
  }

  return null;
}

/**
 * Safely removes a temporary file, suppressing any filesystem errors.
 */
export function cleanupTempFile(filePath: string): boolean {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch {
    // Gracefully ignore cleanup errors
  }
  return false;
}

/**
 * Coordinates fetching and playing the voice summary debrief.
 */
export async function playVoiceDebrief(
  summaryText: string,
  options?: {
    baseUrl?: string;
    files?: StagedFileForAiScan[];
    env?: AudioPlayerEnv;
    verbose?: boolean;
    fallbackDir?: string;
    keepTempFile?: boolean;
    platform?: NodeJS.Platform;
  },
): Promise<AudioPlaybackResult> {
  const env = options?.env ?? process.env;
  if (isNonInteractiveCiEnvironment(env)) {
    if (options?.verbose) {
      console.log("ℹ️  [SecureFlow] Audio debrief skipped in non-interactive CI environment.");
    }
    return { played: false, bypassed: true };
  }

  const audioBuffer = await fetchAudioSummary(summaryText, options);
  const tempPath = path.join(
    os.tmpdir(),
    `secureflow-summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`,
  );
  const bufferToWrite =
    !audioBuffer || audioBuffer.length === 0
      ? Buffer.from("ID3\x04\x00\x00\x00\x00\x00#TSSE\x00\x00\x00\x0f\x00\x00\x03Lavf58.29.100\x00")
      : audioBuffer;

  try {
    fs.writeFileSync(tempPath, bufferToWrite);
    return playAudioFile(tempPath, options);
  } finally {
    if (!options?.keepTempFile) {
      cleanupTempFile(tempPath);
    }
  }
}
