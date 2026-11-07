import { describe, expect, it } from "vitest";
import { KNOWLEDGE_BASE, queryLiveThreatIntelligence } from "./threat-intel.js";

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
