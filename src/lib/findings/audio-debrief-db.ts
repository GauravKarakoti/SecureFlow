/**
 * Database-backed audio debrief cache (#1377).
 *
 * Provides a Prisma-based fallback persistence layer for generated ElevenLabs
 * audio debriefs that survives Redis evictions and process restarts.
 * Works in tandem with the Redis/in-memory layer in audio-debrief.ts.
 */

import prisma from "@/lib/prisma";

export interface DbAudioCacheEntry {
  contentHash: string;
  audioBase64: string;
  findingId?: string;
  format?: string;
  source?: string;
  expiresAt?: Date;
}

/**
 * Retrieves cached audio buffer from the database by content hash.
 * Updates `hitCount` and `lastAccessed` on each cache hit.
 */
export async function getDbAudioCache(contentHash: string): Promise<Buffer | null> {
  try {
    const entry = await prisma.audioDebriefCache.findUnique({
      where: { contentHash },
      select: {
        id: true,
        audioBase64: true,
        expiresAt: true,
      },
    });

    if (!entry) return null;

    // Respect explicit TTL if set
    if (entry.expiresAt && new Date() > entry.expiresAt) {
      // Async cleanup — do not await so callers are not delayed
      prisma.audioDebriefCache.delete({ where: { contentHash } }).catch(() => {});
      return null;
    }

    // Increment hit counter and refresh last-accessed timestamp asynchronously
    prisma.audioDebriefCache
      .update({
        where: { contentHash },
        data: {
          hitCount: { increment: 1 },
          lastAccessed: new Date(),
        },
      })
      .catch(() => {});

    return Buffer.from(entry.audioBase64, "base64");
  } catch (err) {
    console.warn("[AUDIO_DB_CACHE] Failed to read from database cache:", err);
    return null;
  }
}

/**
 * Persists an audio buffer to the database cache with deduplication by content hash.
 */
export async function setDbAudioCache(entry: DbAudioCacheEntry): Promise<void> {
  try {
    await prisma.audioDebriefCache.upsert({
      where: { contentHash: entry.contentHash },
      create: {
        contentHash: entry.contentHash,
        audioBase64: entry.audioBase64,
        findingId: entry.findingId,
        format: entry.format ?? "audio/mpeg",
        fileSize: Buffer.byteLength(entry.audioBase64, "base64"),
        source: entry.source ?? "elevenlabs",
        expiresAt: entry.expiresAt,
        hitCount: 0,
        lastAccessed: new Date(),
      },
      update: {
        // On collision (duplicate synthesis), refresh expiry only
        expiresAt: entry.expiresAt,
        lastAccessed: new Date(),
      },
    });
  } catch (err) {
    console.warn("[AUDIO_DB_CACHE] Failed to persist audio to database cache:", err);
  }
}

/**
 * Evicts stale audio debrief cache entries older than `olderThanDays` days.
 * Designed to be called from a scheduled cleanup job.
 * Returns the number of rows deleted.
 */
export async function evictStaleDbAudioCache(olderThanDays: number = 30): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const result = await prisma.audioDebriefCache.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: new Date() } }, { lastAccessed: { lt: cutoff } }],
      },
    });
    return result.count;
  } catch (err) {
    console.warn("[AUDIO_DB_CACHE] Failed to evict stale entries:", err);
    return 0;
  }
}

/**
 * Returns basic statistics for the audio debrief cache table.
 */
export async function getDbAudioCacheStats(): Promise<{
  totalEntries: number;
  totalHits: number;
  oldestEntryDays: number | null;
}> {
  try {
    const [count, aggregate, oldest] = await Promise.all([
      prisma.audioDebriefCache.count(),
      prisma.audioDebriefCache.aggregate({ _sum: { hitCount: true } }),
      prisma.audioDebriefCache.findFirst({
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
    ]);
    const oldestEntryDays = oldest
      ? Math.floor((Date.now() - oldest.createdAt.getTime()) / (1000 * 60 * 60 * 24))
      : null;
    return {
      totalEntries: count,
      totalHits: aggregate._sum.hitCount ?? 0,
      oldestEntryDays,
    };
  } catch {
    return { totalEntries: 0, totalHits: 0, oldestEntryDays: null };
  }
}
