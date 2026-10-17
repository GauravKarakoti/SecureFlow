import { createHash } from "node:crypto";
import { redis } from "@/lib/redis";
import { env } from "@/lib/env";

const PREFIX = "audio-cache:";
const DEFAULT_TTL_SECONDS = 86400;
const MAX_LOCAL_ENTRIES = 100;

// Local fallback used when Redis is unavailable
const localCache = new Map<string, { audio: Buffer; expiresAt: number }>();

function ttlSeconds(): number {
  const parsed = Number(env.AUDIO_CACHE_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}

export function audioCacheKey(text: string, voiceId: string, modelId: string): string {
  // NUL separator avoids collisions such as ("ab","c") vs ("a","bc")
  const hash = createHash("sha256").update(`${text}\u0000${voiceId}\u0000${modelId}`).digest("hex");
  return `${PREFIX}${hash}`;
}

function getLocal(key: string): Buffer | null {
  const entry = localCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    localCache.delete(key);
    return null;
  }
  return entry.audio;
}

function setLocal(key: string, audio: Buffer, ttl: number): void {
  if (localCache.size >= MAX_LOCAL_ENTRIES) {
    const oldest = localCache.keys().next().value;
    if (oldest !== undefined) localCache.delete(oldest);
  }
  localCache.set(key, { audio, expiresAt: Date.now() + ttl * 1000 });
}

export async function getCachedAudio(key: string): Promise<Buffer | null> {
  try {
    if (redis) {
      const hit = await (redis as any).getBuffer(key);
      if (hit) return hit;
    }
  } catch (err) {
    console.warn("[audio-cache] Redis read failed, falling back to local", err);
  }
  return getLocal(key);
}

export async function setCachedAudio(
  key: string,
  audio: Buffer,
  ttl: number = ttlSeconds(),
): Promise<void> {
  setLocal(key, audio, ttl);
  try {
    if (redis) await (redis as any).set(key, audio, "EX", ttl);
  } catch (err) {
    console.warn("[audio-cache] Redis write failed, kept local copy only", err);
  }
}

export async function getOrSynthesize(
  text: string,
  voiceId: string,
  modelId: string,
  synthesize: () => Promise<Buffer>,
): Promise<Buffer> {
  const key = audioCacheKey(text, voiceId, modelId);
  const hit = await getCachedAudio(key);
  if (hit) return hit;
  const audio = await synthesize();
  await setCachedAudio(key, audio);
  return audio;
}
