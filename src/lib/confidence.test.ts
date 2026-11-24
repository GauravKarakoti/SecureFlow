import { describe, it, expect } from "vitest";
import {
  parseConfidence,
  normalizeConfidence,
  isConfidenceAtLeast,
  filterFindingsByConfidence,
  confidenceRank,
  DEFAULT_CONFIDENCE,
} from "./confidence";

describe("Confidence parsing and normalization (#1924)", () => {
  describe("parseConfidence", () => {
    it("parses canonical confidence values", () => {
      expect(parseConfidence("HIGH")).toBe("HIGH");
      expect(parseConfidence("MEDIUM")).toBe("MEDIUM");
      expect(parseConfidence("LOW")).toBe("LOW");
    });

    it("parses lowercase and mixed case values", () => {
      expect(parseConfidence("high")).toBe("HIGH");
      expect(parseConfidence("Medium")).toBe("MEDIUM");
      expect(parseConfidence("low")).toBe("LOW");
    });

    it("parses trimmed strings and aliases", () => {
      expect(parseConfidence("  HIGH  ")).toBe("HIGH");
      expect(parseConfidence("med")).toBe("MEDIUM");
      expect(parseConfidence("moderate")).toBe("MEDIUM");
      expect(parseConfidence("lo")).toBe("LOW");
    });

    it("returns null for invalid or non-string values", () => {
      expect(parseConfidence("CRITICAL")).toBeNull();
      expect(parseConfidence("UNKNOWN")).toBeNull();
      expect(parseConfidence("")).toBeNull();
      expect(parseConfidence(null)).toBeNull();
      expect(parseConfidence(undefined)).toBeNull();
      expect(parseConfidence(123)).toBeNull();
      expect(parseConfidence({})).toBeNull();
    });
  });

  describe("normalizeConfidence", () => {
    it("returns parsed confidence when valid", () => {
      expect(normalizeConfidence("HIGH")).toBe("HIGH");
      expect(normalizeConfidence("low")).toBe("LOW");
    });

    it("defaults safely to MEDIUM when missing or null", () => {
      expect(normalizeConfidence(undefined)).toBe(DEFAULT_CONFIDENCE);
      expect(normalizeConfidence(null)).toBe(DEFAULT_CONFIDENCE);
      expect(normalizeConfidence("")).toBe(DEFAULT_CONFIDENCE);
    });

    it("defaults safely to MEDIUM when invalid", () => {
      expect(normalizeConfidence("invalid_confidence")).toBe("MEDIUM");
      expect(normalizeConfidence(42)).toBe("MEDIUM");
    });

    it("respects custom fallback", () => {
      expect(normalizeConfidence("invalid", "HIGH")).toBe("HIGH");
      expect(normalizeConfidence(null, "LOW")).toBe("LOW");
    });
  });

  describe("confidenceRank and isConfidenceAtLeast", () => {
    it("ranks HIGH > MEDIUM > LOW", () => {
      expect(confidenceRank("HIGH")).toBeGreaterThan(confidenceRank("MEDIUM"));
      expect(confidenceRank("MEDIUM")).toBeGreaterThan(confidenceRank("LOW"));
    });

    it("evaluates isConfidenceAtLeast correctly", () => {
      expect(isConfidenceAtLeast("HIGH", "HIGH")).toBe(true);
      expect(isConfidenceAtLeast("HIGH", "MEDIUM")).toBe(true);
      expect(isConfidenceAtLeast("HIGH", "LOW")).toBe(true);

      expect(isConfidenceAtLeast("MEDIUM", "HIGH")).toBe(false);
      expect(isConfidenceAtLeast("MEDIUM", "MEDIUM")).toBe(true);
      expect(isConfidenceAtLeast("MEDIUM", "LOW")).toBe(true);

      expect(isConfidenceAtLeast("LOW", "HIGH")).toBe(false);
      expect(isConfidenceAtLeast("LOW", "MEDIUM")).toBe(false);
      expect(isConfidenceAtLeast("LOW", "LOW")).toBe(true);
    });

    it("handles missing confidence safely with MEDIUM default in comparisons", () => {
      expect(isConfidenceAtLeast(undefined, "MEDIUM")).toBe(true);
      expect(isConfidenceAtLeast(undefined, "HIGH")).toBe(false);
      expect(isConfidenceAtLeast(undefined, "LOW")).toBe(true);
    });
  });

  describe("filterFindingsByConfidence", () => {
    const findings = [
      { id: "1", type: "Secret", confidence: "HIGH" },
      { id: "2", type: "Vulnerability", confidence: "MEDIUM" },
      { id: "3", type: "Misconfig", confidence: "LOW" },
      { id: "4", type: "Vulnerability" }, // missing -> defaults to MEDIUM
    ];

    it("filters findings below HIGH threshold", () => {
      const result = filterFindingsByConfidence(findings, "HIGH");
      expect(result.visible.map((f) => f.id)).toEqual(["1"]);
      expect(result.hiddenCount).toBe(3);
    });

    it("filters findings below MEDIUM threshold", () => {
      const result = filterFindingsByConfidence(findings, "MEDIUM");
      expect(result.visible.map((f) => f.id)).toEqual(["1", "2", "4"]);
      expect(result.hiddenCount).toBe(1);
    });

    it("includes all findings with LOW threshold", () => {
      const result = filterFindingsByConfidence(findings, "LOW");
      expect(result.visible.map((f) => f.id)).toEqual(["1", "2", "3", "4"]);
      expect(result.hiddenCount).toBe(0);
    });
  });
});
