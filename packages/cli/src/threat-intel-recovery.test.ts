import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ readFile: vi.fn(), get: vi.fn(), set: vi.fn(), del: vi.fn() }));
vi.mock("node:fs/promises", () => ({ default: { readFile: mocks.readFile } }));
vi.mock("ioredis", () => ({
  Redis: class {
    get = mocks.get;
    set = mocks.set;
    del = mocks.del;
    on() {
      return this;
    }
    disconnect() {}
  },
}));
import {
  closeThreatIntelCache,
  getThreatIntelCacheWithSwr,
  setThreatIntelCache,
  setThreatIntelCacheEnvelopeRawForTesting,
} from "./threat-intel-cache.js";
import { loadCisaKevCatalog } from "./threat-intel-feed.js";
const validCatalog = {
  title: "Synthetic KEV catalog",
  catalogVersion: "2026.01.01",
  dateReleased: "2026-01-01",
  count: 0,
  vulnerabilities: [],
};
const missing = () => Object.assign(new Error("SYNTHETIC_PRIVATE_SENTINEL"), { code: "ENOENT" });
beforeEach(() => {
  closeThreatIntelCache();
  vi.stubEnv("REDIS_URL", "");
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(null);
  mocks.set.mockResolvedValue("OK");
  mocks.del.mockResolvedValue(1);
  mocks.readFile.mockRejectedValue(missing());
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  closeThreatIntelCache();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("threat intelligence corruption diagnostics and recovery", () => {
  it.each(["", "SYNTHETIC_PRIVATE_SENTINEL{"])(
    "reports malformed memory JSON once, rejects it even in outage fallback, then accepts a refreshed entry (%j)",
    async (raw) => {
      setThreatIntelCacheEnvelopeRawForTesting(
        "secureflow:threat-intel:v1:synthetic-key",
        raw,
        Date.now() + 10000,
      );
      expect(
        await getThreatIntelCacheWithSwr("synthetic-key", { allowExpiredFallback: true }),
      ).toBeNull();
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
        "SYNTHETIC_PRIVATE_SENTINEL",
      );
      expect(await getThreatIntelCacheWithSwr("synthetic-key")).toBeNull();
      expect(console.warn).toHaveBeenCalledTimes(1);
      await setThreatIntelCache("synthetic-key", { id: "synthetic-record" });
      expect((await getThreatIntelCacheWithSwr<{ id: string }>("synthetic-key"))?.value.id).toBe(
        "synthetic-record",
      );
    },
  );
  it("reports malformed Redis JSON without exposing the payload or connection URL", async () => {
    vi.stubEnv("REDIS_URL", "redis://synthetic.invalid");
    mocks.get.mockResolvedValue("SYNTHETIC_PRIVATE_SENTINEL{");
    expect(await getThreatIntelCacheWithSwr("synthetic-key")).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
    const output = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(output).not.toContain("SYNTHETIC_PRIVATE_SENTINEL");
    expect(output).not.toContain("redis://");
  });
  it("keeps an ordinary cold miss and absent local catalog quiet", async () => {
    expect(await getThreatIntelCacheWithSwr("missing-key")).toBeNull();
    expect(await loadCisaKevCatalog({ populateCache: false })).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });
  it("distinguishes malformed local JSON, invalid structure and unreadable files with safe diagnostics", async () => {
    for (const outcome of [
      "{SYNTHETIC_PRIVATE_SENTINEL",
      JSON.stringify({ private: "SYNTHETIC_PRIVATE_SENTINEL" }),
      Object.assign(new Error("SYNTHETIC_PRIVATE_SENTINEL"), { code: "EACCES" }),
    ]) {
      vi.mocked(console.warn).mockClear();
      mocks.readFile.mockImplementation(async (path: unknown) => {
        if (String(path).endsWith(".sha256")) throw missing();
        if (outcome instanceof Error) throw outcome;
        return outcome;
      });
      expect(await loadCisaKevCatalog({ populateCache: false })).toBeNull();
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
        "SYNTHETIC_PRIVATE_SENTINEL",
      );
    }
  });
  it("recovers to a valid local catalog after a malformed copy is replaced", async () => {
    mocks.readFile.mockImplementation(async (path: unknown) => {
      if (String(path).endsWith(".sha256")) throw missing();
      return "{";
    });
    expect(await loadCisaKevCatalog({ populateCache: false })).toBeNull();
    mocks.readFile.mockImplementation(async (path: unknown) => {
      if (String(path).endsWith(".sha256")) throw missing();
      return JSON.stringify(validCatalog);
    });
    expect(await loadCisaKevCatalog({ populateCache: false })).toEqual(validCatalog);
  });
  it("preserves exact fresh/stale/expired boundaries and explicit expired outage fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await setThreatIntelCache("boundary-key", { id: "synthetic-record" }, 1, 2);
    vi.advanceTimersByTime(999);
    expect((await getThreatIntelCacheWithSwr("boundary-key"))?.isStale).toBe(false);
    vi.advanceTimersByTime(1);
    expect((await getThreatIntelCacheWithSwr("boundary-key"))?.isStale).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(
      (await getThreatIntelCacheWithSwr("boundary-key", { allowExpiredFallback: true }))?.isStale,
    ).toBe(true);
    expect(await getThreatIntelCacheWithSwr("boundary-key")).toBeNull();
  });
});
