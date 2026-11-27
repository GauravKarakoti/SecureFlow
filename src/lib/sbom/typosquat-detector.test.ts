import { describe, it, expect, vi } from "vitest";
import {
  damerauLevenshtein,
  normalizeConfusables,
  detectTyposquatRisks,
} from "./typosquat-detector";
import { matchSupplyChainRisks } from "./vulnerability-matcher";
import type { Dependency } from "@/types/sbom";

vi.mock("./osv-client", () => ({
  queryOsvForDependency: vi.fn().mockResolvedValue([]),
  mapOsvVulns: vi.fn().mockReturnValue([]),
}));

describe("Deterministic Typosquatting, Homoglyph & Dependency Confusion Detector (#2176)", () => {
  it("computes Damerau-Levenshtein distance treating adjacent transpositions as distance 1", () => {
    expect(damerauLevenshtein("lodash", "lodahs")).toBe(1);
    expect(damerauLevenshtein("requests", "reqeusts")).toBe(1);
    expect(damerauLevenshtein("axios", "axois")).toBe(1);
    expect(damerauLevenshtein("lodash", "lodash")).toBe(0);
  });

  it("normalizes visual confusable and homoglyph characters", () => {
    expect(normalizeConfusables("l0dash")).toBe("lodash");
    expect(normalizeConfusables("axi0s")).toBe("axios");
    expect(normalizeConfusables("re\u0430ct")).toBe("react"); // Cyrillic а -> a
  });

  it("detects typosquatting, homoglyphs, and affix impersonations across ecosystems", () => {
    const deps: Dependency[] = [
      { name: "lodahs", version: "4.17.21", manifestFile: "package.json", ecosystem: "npm" },
      { name: "reqeusts", version: "2.31.0", manifestFile: "requirements.txt", ecosystem: "pypi" },
      { name: "l0dash", version: "1.0.0", manifestFile: "package.json", ecosystem: "npm" },
      { name: "node-express", version: "1.0.0", manifestFile: "package.json", ecosystem: "npm" },
      {
        name: "py-requests",
        version: "1.0.0",
        manifestFile: "requirements.txt",
        ecosystem: "pypi",
      },
    ];

    const risks = detectTyposquatRisks(deps);
    expect(risks).toHaveLength(5);

    expect(risks[0]).toMatchObject({ kind: "typosquat", targetPackage: "lodash", editDistance: 1 });
    expect(risks[1]).toMatchObject({
      kind: "typosquat",
      targetPackage: "requests",
      editDistance: 1,
    });
    expect(risks[2]).toMatchObject({
      kind: "homoglyph",
      targetPackage: "lodash",
      severity: "CRITICAL",
    });
    expect(risks[3]).toMatchObject({ kind: "affix-impersonation", targetPackage: "express" });
    expect(risks[4]).toMatchObject({ kind: "affix-impersonation", targetPackage: "requests" });
  });

  it("detects dependency confusion via hijack versions (>=99.x) and internal package collisions", () => {
    const deps: Dependency[] = [
      {
        name: "acme-auth-utils",
        version: "99.9.9",
        manifestFile: "package.json",
        ecosystem: "npm",
      },
      {
        name: "internal-core-sdk",
        version: "1.2.0",
        manifestFile: "package.json",
        ecosystem: "npm",
      },
    ];

    const risks = detectTyposquatRisks(deps, {
      internalPackages: ["@acme/internal-core-sdk"],
    });

    expect(risks).toHaveLength(2);
    expect(risks[0]?.kind).toBe("dependency-confusion");
    expect(risks[0]?.severity).toBe("CRITICAL");
    expect(risks[1]?.kind).toBe("dependency-confusion");
    expect(risks[1]?.severity).toBe("CRITICAL");
  });

  it("produces zero false positives on legitimate popular packages", () => {
    const legitimate: Dependency[] = [
      { name: "lodash", version: "4.17.21", manifestFile: "package-lock.json", ecosystem: "npm" },
      { name: "express", version: "4.19.2", manifestFile: "package-lock.json", ecosystem: "npm" },
      { name: "react", version: "18.2.0", manifestFile: "package-lock.json", ecosystem: "npm" },
      { name: "requests", version: "2.31.0", manifestFile: "requirements.txt", ecosystem: "pypi" },
      { name: "serde", version: "1.0.197", manifestFile: "Cargo.lock", ecosystem: "cargo" },
    ];

    expect(detectTyposquatRisks(legitimate)).toEqual([]);
  });

  it("integrates with matchSupplyChainRisks in vulnerability-matcher.ts", async () => {
    const deps: Dependency[] = [
      { name: "axois", version: "1.6.0", manifestFile: "package.json", ecosystem: "npm" },
    ];

    const result = await matchSupplyChainRisks(deps);
    expect(result.vulnerabilities).toEqual([]);
    expect(result.typosquatRisks).toHaveLength(1);
    expect(result.typosquatRisks[0]?.targetPackage).toBe("axios");
  });
});
