/**
 * Unit tests for audio-debrief caching and database fallback (#1377).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { findUniqueMock, upsertMock, deleteManyMock, aggregateMock, countMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  upsertMock: vi.fn(),
  deleteManyMock: vi.fn(),
  aggregateMock: vi.fn(),
  countMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    audioDebriefCache: {
      findUnique: findUniqueMock,
      upsert: upsertMock,
      deleteMany: deleteManyMock,
      aggregate: aggregateMock,
      count: countMock,
      delete: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue({ createdAt: new Date(Date.now() - 86400000 * 5) }),
    },
  },
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
  },
}));

import {
  getDbAudioCache,
  setDbAudioCache,
  evictStaleDbAudioCache,
  getDbAudioCacheStats,
} from "./audio-debrief-db";
import {
  generateAuditoryBrief,
  getAudioDebriefCacheKey,
  createFallbackAudioBuffer,
} from "./audio-debrief";

describe("audio-debrief-db (#1377)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retrieves audio buffer from database cache by contentHash", async () => {
    const rawBuffer = Buffer.from("audio-bytes-test");
    findUniqueMock.mockResolvedValueOnce({
      id: "cache-1",
      audioBase64: rawBuffer.toString("base64"),
      expiresAt: null,
    });

    const result = await getDbAudioCache("test-hash-1");
    expect(result).not.toBeNull();
    expect(result?.toString()).toBe("audio-bytes-test");
    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contentHash: "test-hash-1" } }),
    );
  });

  it("returns null when entry is expired", async () => {
    const rawBuffer = Buffer.from("expired-audio");
    findUniqueMock.mockResolvedValueOnce({
      id: "cache-expired",
      audioBase64: rawBuffer.toString("base64"),
      expiresAt: new Date(Date.now() - 10000), // past
    });

    const result = await getDbAudioCache("test-hash-expired");
    expect(result).toBeNull();
  });

  it("returns null on database error without throwing", async () => {
    findUniqueMock.mockRejectedValueOnce(new Error("DB connection failure"));
    const result = await getDbAudioCache("error-hash");
    expect(result).toBeNull();
  });

  it("persists audio buffer to database cache via upsert", async () => {
    upsertMock.mockResolvedValueOnce({ id: "cache-new" });

    await setDbAudioCache({
      contentHash: "hash-new",
      audioBase64: Buffer.from("new-audio").toString("base64"),
      findingId: "f-123",
      format: "audio/mpeg",
      source: "elevenlabs",
    });

    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { contentHash: "hash-new" },
        create: expect.objectContaining({
          contentHash: "hash-new",
          findingId: "f-123",
        }),
      }),
    );
  });

  it("evicts stale audio debrief entries", async () => {
    deleteManyMock.mockResolvedValueOnce({ count: 7 });
    const count = await evictStaleDbAudioCache(30);
    expect(count).toBe(7);
  });

  it("fetches audio debrief cache statistics", async () => {
    countMock.mockResolvedValueOnce(42);
    aggregateMock.mockResolvedValueOnce({ _sum: { hitCount: 150 } });

    const stats = await getDbAudioCacheStats();
    expect(stats.totalEntries).toBe(42);
    expect(stats.totalHits).toBe(150);
  });
});

describe("audio-debrief helpers (#1377)", () => {
  it("formats a concise auditory brief", () => {
    const brief = generateAuditoryBrief({
      findingType: "SQL_INJECTION",
      severity: "CRITICAL",
      fileLocation: "src/db.ts:15",
      explanation: "User input directly concatenated into SQL query.",
      remediation: "Use parameterized queries or ORM.",
    });
    expect(brief.toUpperCase()).toContain("CRITICAL");
    expect(brief).toContain("SQL_INJECTION");
    expect(brief).toContain("src/db.ts:15");
  });

  it("computes deterministic audio debrief cache key", () => {
    const key1 = getAudioDebriefCacheKey("f-1", "Brief text", "Remediation text");
    const key2 = getAudioDebriefCacheKey("f-1", "Brief text", "Remediation text");
    const key3 = getAudioDebriefCacheKey("f-1", "Different text", "Remediation text");
    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
  });

  it("generates a valid MPEG fallback buffer", () => {
    const buffer = createFallbackAudioBuffer();
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer[0]).toBe(0xff);
    expect(buffer[1]).toBe(0xfb);
  });
});
