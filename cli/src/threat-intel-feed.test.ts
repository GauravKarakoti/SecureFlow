import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupOsvAdvisory } from "./threat-intel-feed.js";
import { setThreatIntelCache, clearMemoryThreatIntelCache } from "./threat-intel-cache.js";

describe("threat-intel-feed SWR & HTTP failure fallback (#1795)", () => {
  beforeEach(() => {
    clearMemoryThreatIntelCache();
    vi.restoreAllMocks();
  });

  it("lookupOsvAdvisory falls back to cached stale advisory during HTTP 429 and 500 errors", async () => {
    const cve = "CVE-2024-4444";
    const cachedAdvisory = {
      id: cve,
      summary: "Stale Cached Advisory",
      details: "Cached details before 429",
    };

    await setThreatIntelCache(`osv-advisory-${cve}`, cachedAdvisory, 1, 2);

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      } as any);

      const result429 = await lookupOsvAdvisory(cve, { allowStale: false });
      expect(result429).not.toBeNull();
      expect(result429?.summary).toBe("Stale Cached Advisory");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      } as any);

      const result503 = await lookupOsvAdvisory(cve, { allowStale: false });
      expect(result503).not.toBeNull();
      expect(result503?.summary).toBe("Stale Cached Advisory");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lookupOsvAdvisory falls back to cached advisory on network timeout", async () => {
    const cve = "CVE-2024-5555";
    const cachedAdvisory = {
      id: cve,
      summary: "Timeout Fallback Advisory",
      details: "Cached details before timeout",
    };

    await setThreatIntelCache(`osv-advisory-${cve}`, cachedAdvisory, 1, 2);

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network timeout after 15000ms"));

      const result = await lookupOsvAdvisory(cve, { allowStale: false });
      expect(result).not.toBeNull();
      expect(result?.summary).toBe("Timeout Fallback Advisory");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles empty and malformed CVE queries safely without unhandled rejections", async () => {
    const invalidNull = await lookupOsvAdvisory("");
    expect(invalidNull).toBeNull();

    const notACve = await lookupOsvAdvisory("INVALID-CVE-ID");
    expect(notACve).toBeNull();
  });

  it("returns null when remote advisory returns 404 Not Found", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      } as any);

      const result = await lookupOsvAdvisory("CVE-2099-0001", { allowStale: false });
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
