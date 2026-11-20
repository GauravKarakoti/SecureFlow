import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchCisaKevCatalog: vi.fn(),
  lookupCisaKevEntry: vi.fn(),
  lookupOsvAdvisory: vi.fn(),
}));

vi.mock("./threat-intel-feed.js", () => mocks);

import {
  KNOWLEDGE_BASE,
  lookupThreatIntelligenceById,
  queryLiveThreatIntelligence,
  searchThreatIntelligence,
} from "./threat-intel.js";

beforeEach(() => {
  mocks.searchCisaKevCatalog.mockReset().mockResolvedValue([]);
  mocks.lookupCisaKevEntry.mockReset().mockResolvedValue(null);
  mocks.lookupOsvAdvisory.mockReset().mockResolvedValue(null);
});

describe("queryLiveThreatIntelligence", () => {
  it("returns an empty string for an empty query", async () => {
    await expect(queryLiveThreatIntelligence("")).resolves.toBe("");
  });

  it("returns an empty string for a whitespace-only query", async () => {
    await expect(queryLiveThreatIntelligence("   \t\n  ")).resolves.toBe("");
  });

  it("returns an empty string when nothing matches", async () => {
    await expect(queryLiveThreatIntelligence("totally-unrelated-topic-xyz")).resolves.toBe("");
  });

  it("matches by category", async () => {
    const result = await queryLiveThreatIntelligence("sql injection");
    expect(result).toContain("CVE-2023-3409");
    expect(result).toContain("Category: SQL Injection");
  });

  it("matches by CVE identifier, case-insensitively", async () => {
    const result = await queryLiveThreatIntelligence("cve-2023-28154");
    expect(result).toContain("CVE-2023-28154");
    expect(result).toContain("(HIGH)");
  });

  it("surrounds the query with whitespace and still matches", async () => {
    const result = await queryLiveThreatIntelligence("  prompt injection  ");
    expect(result).toContain("CWE-94");
  });

  it("every knowledge-base entry is retrievable by its cve or category", async () => {
    for (const entry of KNOWLEDGE_BASE) {
      const result = await queryLiveThreatIntelligence(entry.cve ?? entry.category);
      expect(result).toContain(entry.id);
    }
  });
});

describe("live threat intelligence integration", () => {
  it("returns synchronized CISA KEV records with exploited status", async () => {
    mocks.searchCisaKevCatalog.mockResolvedValueOnce([
      {
        cveID: "CVE-2024-12345",
        vendorProject: "Example Vendor",
        product: "Example Product",
        vulnerabilityName: "Remote Code Execution",
        dateAdded: "2024-01-01",
        shortDescription: "Remote code execution vulnerability.",
        requiredAction: "Apply the vendor security update.",
        dueDate: "2024-02-01",
      },
    ]);

    const results = await searchThreatIntelligence("CVE-2024-12345");

    expect(results[0]).toMatchObject({
      id: "CVE-2024-12345",
      source: "CISA KEV",
      knownExploited: true,
    });
  });

  it("combines OSV details with CISA known-exploited status", async () => {
    mocks.lookupOsvAdvisory.mockResolvedValueOnce({
      id: "CVE-2024-12345",
      summary: "Example vulnerability",
      aliases: [],
      severity: [{ type: "CVSS_V3", score: "9.8" }],
    });

    mocks.lookupCisaKevEntry.mockResolvedValueOnce({
      cveID: "CVE-2024-12345",
      vendorProject: "Example Vendor",
      product: "Example Product",
      vulnerabilityName: "Remote Code Execution",
      dateAdded: "2024-01-01",
      shortDescription: "Remote code execution vulnerability.",
      requiredAction: "Apply the vendor security update.",
      dueDate: "2024-02-01",
    });

    const result = await lookupThreatIntelligenceById("cve-2024-12345");

    expect(result).toMatchObject({
      id: "CVE-2024-12345",
      source: "OSV + CISA KEV",
      knownExploited: true,
    });
  });

  it("falls back to the bundled knowledge base when live lookups fail", async () => {
    mocks.lookupOsvAdvisory.mockRejectedValueOnce(new Error("OSV unavailable"));
    mocks.lookupCisaKevEntry.mockRejectedValueOnce(new Error("CISA unavailable"));

    const result = await lookupThreatIntelligenceById("CVE-2023-3409");

    expect(result).toMatchObject({
      id: "CVE-2023-3409",
      source: "BUNDLED",
      knownExploited: null,
      liveLookupUnavailable: true,
    });
  });

  it("updates resolution source to stale-fallback when live service lookup is unavailable (#1795)", async () => {
    const { getThreatIntelSource, setThreatIntelSource } = await import("./threat-intel.js");
    setThreatIntelSource("live");

    mocks.lookupOsvAdvisory.mockRejectedValueOnce(new Error("Network timeout after 15000ms"));
    mocks.lookupCisaKevEntry.mockRejectedValueOnce(new Error("Service Unavailable"));

    await lookupThreatIntelligenceById("CVE-2023-3409");
    expect(getThreatIntelSource()).toBe("stale-fallback");
  });

  it("resolves threat-intel source as live when live catalog search returns matches (#1795)", async () => {
    const { getThreatIntelSource, setThreatIntelSource } = await import("./threat-intel.js");
    setThreatIntelSource("stale-fallback");

    mocks.searchCisaKevCatalog.mockResolvedValueOnce([
      {
        cveID: "CVE-2024-9999",
        vendorProject: "Test Vendor",
        product: "Test Product",
        vulnerabilityName: "Test Vuln",
        dateAdded: "2024-01-01",
        shortDescription: "Test Description",
        requiredAction: "Apply fix",
        dueDate: "2024-02-01",
      },
    ]);

    await searchThreatIntelligence("CVE-2024-9999");
    expect(getThreatIntelSource()).toBe("live");
  });
});

describe("threat-intel-cache SWR & Checksum Verification (#1750)", () => {
  it("verifies SHA-256 payload checksums and detects tampered content", async () => {
    const { computePayloadSha256, verifyPayloadChecksum } = await import("./threat-intel-cache.js");

    const payload = { cveID: "CVE-2024-9999", description: "Sample payload" };
    const hash = computePayloadSha256(payload);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPayloadChecksum(payload, hash)).toBe(true);

    const tamperedPayload = { ...payload, description: "Tampered content" };
    expect(verifyPayloadChecksum(tamperedPayload, hash)).toBe(false);
  });

  it("stores and reads cached values with SWR freshness and stale detection", async () => {
    const { setThreatIntelCache, getThreatIntelCacheWithSwr, clearMemoryThreatIntelCache } =
      await import("./threat-intel-cache.js");

    clearMemoryThreatIntelCache();

    const key = "test-cve-swr-key";
    const data = { id: "CVE-2024-1111", title: "Fresh Advisory" };

    // Set with 2 seconds fresh, 10 seconds stale
    await setThreatIntelCache(key, data, 2, 10);

    const freshResult = await getThreatIntelCacheWithSwr<typeof data>(key);
    expect(freshResult).not.toBeNull();
    expect(freshResult?.value).toEqual(data);
    expect(freshResult?.isStale).toBe(false);
    expect(freshResult?.sha256).toBeDefined();

    // Advance time beyond fresh TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(3000);

    const staleResult = await getThreatIntelCacheWithSwr<typeof data>(key);
    expect(staleResult).not.toBeNull();
    expect(staleResult?.value).toEqual(data);
    expect(staleResult?.isStale).toBe(true);

    // Advance beyond stale TTL -> expired
    vi.advanceTimersByTime(8000);
    const expiredResult = await getThreatIntelCacheWithSwr<typeof data>(key);
    expect(expiredResult).toBeNull();

    vi.useRealTimers();
  });

  it("automatically rejects and discards corrupted or tampered cached payloads", async () => {
    const { setThreatIntelCache, getThreatIntelCacheWithSwr, clearMemoryThreatIntelCache } =
      await import("./threat-intel-cache.js");

    clearMemoryThreatIntelCache();

    const key = "corrupted-payload-key";
    const data = { id: "CVE-2024-2222", severity: "HIGH" };

    await setThreatIntelCache(key, data, 10, 20);

    // Tamper the cached envelope in memory directly by modifying the payload data while keeping original sha256
    const redisKey = `secureflow:threat-intel:v1:${key}`;
    const { setThreatIntelCacheEnvelopeRawForTesting } = await import("./threat-intel-cache.js");
    setThreatIntelCacheEnvelopeRawForTesting(
      redisKey,
      JSON.stringify({
        data: { id: "CVE-2024-2222", severity: "TAMPERED_INJECTED" },
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        cachedAt: Date.now(),
        freshUntil: Date.now() + 10000,
        staleUntil: Date.now() + 20000,
      }),
      Date.now() + 20000,
    );

    // With SWR check, corrupted checksum is discarded and returns null
    const result = await getThreatIntelCacheWithSwr<typeof data>(key);
    expect(result).toBeNull();
  });

  it("serves expired fallback entries when allowExpiredFallback is true during feed outages (#1795)", async () => {
    const { setThreatIntelCache, getThreatIntelCacheWithSwr, clearMemoryThreatIntelCache } =
      await import("./threat-intel-cache.js");

    clearMemoryThreatIntelCache();

    const key = "expired-fallback-key";
    const data = { id: "CVE-2024-3333", summary: "Critical Outage Fallback Advisory" };

    // Set with short TTL
    await setThreatIntelCache(key, data, 1, 2);

    vi.useFakeTimers();
    vi.advanceTimersByTime(5000); // Now well expired beyond stale TTL

    // With allowExpiredFallback: true, gracefully returns stale-fallback data
    const fallbackResult = await getThreatIntelCacheWithSwr<typeof data>(key, {
      allowExpiredFallback: true,
    });
    expect(fallbackResult).not.toBeNull();
    expect(fallbackResult?.value).toEqual(data);
    expect(fallbackResult?.isStale).toBe(true);

    // Regular fetch returns null and deletes the entry
    const regularResult = await getThreatIntelCacheWithSwr<typeof data>(key);
    expect(regularResult).toBeNull();

    vi.useRealTimers();
  });
});
