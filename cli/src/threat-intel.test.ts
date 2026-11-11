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
});
