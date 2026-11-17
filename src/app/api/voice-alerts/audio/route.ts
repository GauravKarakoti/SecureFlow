/**
 * GET /api/voice-alerts/audio?repo=owner%2Frepo&decision=BLOCK&severity=CRITICAL
 *
 * Server-side audio synthesis for voice alerts (#1307).
 *
 * Reuses the existing ElevenLabs streaming and caching infrastructure from
 * src/lib/findings/audio-debrief.ts. The ElevenLabs API key never leaves
 * the server. Uses ELEVENLABS_VOICE_ID_ALERT when configured, falling back
 * to the default voice. Returns a silent MP3 fallback if ElevenLabs is
 * unavailable so the application never crashes.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  fetchElevenLabsAudioStream,
  createFallbackAudioBuffer,
  getCachedAudioDebrief,
  setCachedAudioDebrief,
} from "@/lib/findings/audio-debrief";
import { createHash } from "crypto";
export const dynamic = "force-dynamic";
/** Cache TTL for alert audio: 30 days (messages are static and reusable). */
const ALERT_AUDIO_TTL_SECONDS = 60 * 60 * 24 * 30;
/**
 * Upper bound for synthesized alert audio. Alert messages are short, so a
 * response above this size is an upstream error or an unexpected payload,
 * not a playable clip. Keeping the limit below the route's memory budget also
 * prevents a single response from occupying the process while it is buffered
 * for the shared cache.
 */
const MAX_ALERT_AUDIO_BYTES = 2 * 1024 * 1024;
/** Whether a cached or freshly synthesized buffer is plausible MP3 audio. */
function isValidAlertAudio(buffer: Buffer): boolean {
  return buffer.length > 0 && buffer.length <= MAX_ALERT_AUDIO_BYTES;
}
/** Whether an upstream response advertises an audio media type. */
function hasAudioContentType(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  return typeof contentType === "string" && contentType.toLowerCase().startsWith("audio/");
}
/**
 * Reads an upstream audio body without allowing a chunked response to grow
 * past the route's bound. A content-length check catches honest oversized
 * responses before any read; this loop covers missing or incorrect lengths.
 */
async function readAlertAudio(response: Response): Promise<Buffer | null> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    reader = response.body?.getReader() ?? null;
    if (!reader) return null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > MAX_ALERT_AUDIO_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader?.releaseLock();
  }

  if (total === 0) return null;
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}
/** Build the spoken alert message from query parameters. */
function buildAlertText(repo: string, decision: string, severity: string): string {
  const action =
    decision === "BLOCK"
      ? "Deployment has been halted."
      : "Manual review is required before merging.";
  return `Security alert: ${severity.toLowerCase()} policy violation detected in repository ${repo}. ${action}`;
}
/** Cache key for alert audio — based on the alert text content only. */
function alertAudioCacheKey(text: string): string {
  const hash = createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
  return `voice-alert-audio:v1:${hash}`;
}
export async function GET(request: NextRequest) {
  // 1. Authenticate — audio must only be served to signed-in users.
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // 2. Validate query parameters.
  const { searchParams } = request.nextUrl;
  const repo = searchParams.get("repo")?.trim();
  const decision = searchParams.get("decision")?.trim().toUpperCase();
  const severity = searchParams.get("severity")?.trim().toUpperCase();
  if (!repo || !decision || !severity) {
    return NextResponse.json(
      { error: "Missing required query parameters: repo, decision, severity" },
      { status: 400 },
    );
  }
  // 3. Build alert text and cache key.
  const alertText = buildAlertText(repo, decision, severity);
  const cacheKey = alertAudioCacheKey(alertText);
  // 4. Serve from cache if available (Redis → in-memory fallback).
  const cached = await getCachedAudioDebrief(cacheKey);
  if (cached && isValidAlertAudio(cached)) {
    return new Response(new Uint8Array(cached), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "private, max-age=86400",
        "X-Cache": "HIT",
      },
    });
  }
  // 5. Generate audio via ElevenLabs using the alert-specific voice ID.
  const voiceId = process.env.ELEVENLABS_VOICE_ID_ALERT || process.env.ELEVENLABS_VOICE_ID;
  let elevenLabsResponse: Response | null = null;
  try {
    elevenLabsResponse = await fetchElevenLabsAudioStream(alertText, { voiceId });
  } catch {
    elevenLabsResponse = null;
  }
  if (elevenLabsResponse?.body && hasAudioContentType(elevenLabsResponse)) {
    const declaredLength = Number.parseInt(
      elevenLabsResponse.headers.get("content-length") ?? "",
      10,
    );
    if (!Number.isFinite(declaredLength) || declaredLength <= MAX_ALERT_AUDIO_BYTES) {
      // Buffer once so the same bytes can be validated, returned, and cached.
      const audioBuffer = await readAlertAudio(elevenLabsResponse);
      if (audioBuffer && isValidAlertAudio(audioBuffer)) {
        await setCachedAudioDebrief(cacheKey, audioBuffer, ALERT_AUDIO_TTL_SECONDS);
        return new Response(new Uint8Array(audioBuffer), {
          headers: {
            "Content-Type": "audio/mpeg",
            "Cache-Control": "private, max-age=86400",
            "X-Cache": "MISS",
          },
        });
      }
    }
  }
  // 6. Fallback: return silent MP3 frames so the browser does not error out.
  const fallback = createFallbackAudioBuffer(alertText);
  return new Response(new Uint8Array(fallback), {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Cache": "FALLBACK",
    },
  });
}
