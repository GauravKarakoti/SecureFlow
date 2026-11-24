import { describe, it, expect } from "vitest";
import {
  compareScans,
  isScanFailed,
  isScanPartial,
  computeSeverityCounts,
  createEmptySeverityCounts,
  type ComparableScanInput,
  type ScanFindingItem,
} from "./comparison";

function makeFinding(overrides: Partial<ScanFindingItem> = {}): ScanFindingItem {
  return {
    id: `finding-${Math.random().toString(36).substring(2, 9)}`,
    fingerprint: `fp-${Math.random().toString(36).substring(2, 9)}`,
    type: "Vulnerability",
    severity: "HIGH",
    fileLocation: "src/index.ts",
    lineStart: 10,
    lineEnd: 15,
    codeSnippet: "const unsafe = req.query.input;",
    ...overrides,
  };
}

function makeScan(overrides: Partial<ComparableScanInput> = {}): ComparableScanInput {
  return {
    id: `scan-${Math.random().toString(36).substring(2, 9)}`,
    headSha: "abc1234",
    createdAt: new Date().toISOString(),
    riskScore: 20,
    policyDecision: "PASS",
    findings: [],
    status: "COMPLETED",
    totalFiles: 5,
    scannedFiles: 5,
    ...overrides,
  };
}

describe("Scan Comparison (#1923)", () => {
  describe("comparability and validation", () => {
    it("identifies a failed scan via isFailed, status, or error", () => {
      expect(isScanFailed(makeScan({ isFailed: true }))).toBe(true);
      expect(isScanFailed(makeScan({ status: "FAILED" }))).toBe(true);
      expect(isScanFailed(makeScan({ status: "failed" }))).toBe(true);
      expect(isScanFailed(makeScan({ error: "Timeout occurred" }))).toBe(true);
      expect(isScanFailed(makeScan({ isFailed: false, status: "COMPLETED", error: null }))).toBe(
        false,
      );
    });

    it("identifies a partial scan via isPartial, status, or scannedFiles < totalFiles", () => {
      expect(isScanPartial(makeScan({ isPartial: true }))).toBe(true);
      expect(isScanPartial(makeScan({ status: "PARTIAL" }))).toBe(true);
      expect(isScanPartial(makeScan({ status: "partial" }))).toBe(true);
      expect(isScanPartial(makeScan({ totalFiles: 10, scannedFiles: 8 }))).toBe(true);
      expect(isScanPartial(makeScan({ totalFiles: 10, scannedFiles: 10 }))).toBe(false);
    });

    it("returns not comparable with clear message when base scan failed", () => {
      const base = makeScan({ id: "scan-base", status: "FAILED" });
      const target = makeScan({ id: "scan-target" });

      const result = compareScans(base, target);
      expect(result.isComparable).toBe(false);
      expect(result.incomparableReason).toContain("Base scan failed");
      expect(result.summary.newCount).toBe(0);
      expect(result.groups.new.findings).toHaveLength(0);
    });

    it("returns not comparable with clear message when target scan failed", () => {
      const base = makeScan({ id: "scan-base" });
      const target = makeScan({ id: "scan-target", error: "LLM rate limit reached" });

      const result = compareScans(base, target);
      expect(result.isComparable).toBe(false);
      expect(result.incomparableReason).toContain("Target scan failed");
    });

    it("returns not comparable with clear message when base scan is partial", () => {
      const base = makeScan({ id: "scan-base", totalFiles: 12, scannedFiles: 11 });
      const target = makeScan({ id: "scan-target" });

      const result = compareScans(base, target);
      expect(result.isComparable).toBe(false);
      expect(result.incomparableReason).toContain("Base scan is a partial scan");
    });

    it("returns not comparable with clear message when target scan is partial", () => {
      const base = makeScan({ id: "scan-base" });
      const target = makeScan({ id: "scan-target", isPartial: true });

      const result = compareScans(base, target);
      expect(result.isComparable).toBe(false);
      expect(result.incomparableReason).toContain("Target scan is a partial scan");
    });
  });

  describe("diff classification", () => {
    it("handles identical scans: all findings classified as unchanged (0 new, 0 fixed)", () => {
      const f1 = makeFinding({ id: "f1", fingerprint: "fp-1", severity: "CRITICAL" });
      const f2 = makeFinding({ id: "f2", fingerprint: "fp-2", severity: "HIGH" });

      const base = makeScan({ id: "scan-base", findings: [f1, f2] });
      // In a real rescan, IDs might differ but fingerprints are identical
      const f1Rescan = makeFinding({ id: "f1-rescan", fingerprint: "fp-1", severity: "CRITICAL" });
      const f2Rescan = makeFinding({ id: "f2-rescan", fingerprint: "fp-2", severity: "HIGH" });
      const target = makeScan({ id: "scan-target", findings: [f1Rescan, f2Rescan] });

      const result = compareScans(base, target);

      expect(result.isComparable).toBe(true);
      expect(result.summary.newCount).toBe(0);
      expect(result.summary.fixedCount).toBe(0);
      expect(result.summary.unchangedCount).toBe(2);

      expect(result.groups.new.findings).toHaveLength(0);
      expect(result.groups.fixed.findings).toHaveLength(0);
      expect(result.groups.unchanged.findings).toHaveLength(2);

      // Severity counts in unchanged group
      expect(result.summary.unchangedSeverityCounts).toEqual({
        CRITICAL: 1,
        HIGH: 1,
        MEDIUM: 0,
        LOW: 0,
      });
      expect(result.summary.newSeverityCounts).toEqual(createEmptySeverityCounts());
      expect(result.summary.fixedSeverityCounts).toEqual(createEmptySeverityCounts());
    });

    it("handles fully fixed scans: all base findings classified as fixed (0 new, 0 unchanged)", () => {
      const f1 = makeFinding({ id: "f1", fingerprint: "fp-1", severity: "CRITICAL" });
      const f2 = makeFinding({ id: "f2", fingerprint: "fp-2", severity: "MEDIUM" });

      const base = makeScan({ id: "scan-base", findings: [f1, f2] });
      const target = makeScan({ id: "scan-target", findings: [] });

      const result = compareScans(base, target);

      expect(result.isComparable).toBe(true);
      expect(result.summary.newCount).toBe(0);
      expect(result.summary.fixedCount).toBe(2);
      expect(result.summary.unchangedCount).toBe(0);

      expect(result.groups.fixed.findings).toHaveLength(2);
      expect(result.groups.fixed.findings.map((f) => f.id)).toEqual(["f1", "f2"]);

      expect(result.summary.fixedSeverityCounts).toEqual({
        CRITICAL: 1,
        HIGH: 0,
        MEDIUM: 1,
        LOW: 0,
      });
    });

    it("handles fully new findings: all target findings classified as new (0 fixed, 0 unchanged)", () => {
      const f1 = makeFinding({ id: "f1", fingerprint: "fp-old", severity: "LOW" });
      const base = makeScan({ id: "scan-base", findings: [f1] });

      const f2 = makeFinding({ id: "f2", fingerprint: "fp-new-1", severity: "CRITICAL" });
      const f3 = makeFinding({ id: "f3", fingerprint: "fp-new-2", severity: "HIGH" });
      const target = makeScan({ id: "scan-target", findings: [f2, f3] });

      const result = compareScans(base, target);

      expect(result.isComparable).toBe(true);
      expect(result.summary.newCount).toBe(2);
      expect(result.summary.fixedCount).toBe(1);
      expect(result.summary.unchangedCount).toBe(0);

      expect(result.groups.new.findings.map((f) => f.id)).toEqual(["f2", "f3"]);
      expect(result.groups.fixed.findings.map((f) => f.id)).toEqual(["f1"]);

      expect(result.summary.newSeverityCounts).toEqual({
        CRITICAL: 1,
        HIGH: 1,
        MEDIUM: 0,
        LOW: 0,
      });
    });

    it("handles empty scans on both sides correctly", () => {
      const base = makeScan({ id: "scan-base", findings: [] });
      const target = makeScan({ id: "scan-target", findings: [] });

      const result = compareScans(base, target);

      expect(result.isComparable).toBe(true);
      expect(result.summary.newCount).toBe(0);
      expect(result.summary.fixedCount).toBe(0);
      expect(result.summary.unchangedCount).toBe(0);
    });

    it("correctly partitions mixed findings into New, Fixed, and Unchanged with severity counts", () => {
      const fFixed = makeFinding({ id: "f-fixed", fingerprint: "fp-fixed", severity: "HIGH" });
      const fUnchanged1 = makeFinding({ id: "f-u1", fingerprint: "fp-u1", severity: "CRITICAL" });
      const fUnchanged2 = makeFinding({ id: "f-u2", fingerprint: "fp-u2", severity: "LOW" });

      const base = makeScan({ id: "scan-base", findings: [fFixed, fUnchanged1, fUnchanged2] });

      const fNew1 = makeFinding({ id: "f-n1", fingerprint: "fp-n1", severity: "MEDIUM" });
      const fNew2 = makeFinding({ id: "f-n2", fingerprint: "fp-n2", severity: "HIGH" });
      const targetUnchanged1 = makeFinding({
        id: "f-u1-target",
        fingerprint: "fp-u1",
        severity: "CRITICAL",
      });
      const targetUnchanged2 = makeFinding({
        id: "f-u2-target",
        fingerprint: "fp-u2",
        severity: "LOW",
      });

      const target = makeScan({
        id: "scan-target",
        findings: [fNew1, fNew2, targetUnchanged1, targetUnchanged2],
      });

      const result = compareScans(base, target);

      expect(result.isComparable).toBe(true);
      expect(result.summary.newCount).toBe(2);
      expect(result.summary.fixedCount).toBe(1);
      expect(result.summary.unchangedCount).toBe(2);

      // Verify group contents
      expect(result.groups.new.findings.map((f) => f.id)).toEqual(["f-n1", "f-n2"]);
      expect(result.groups.fixed.findings.map((f) => f.id)).toEqual(["f-fixed"]);
      expect(result.groups.unchanged.findings.map((f) => f.id)).toEqual([
        "f-u1-target",
        "f-u2-target",
      ]);

      // Verify severity counts
      expect(result.summary.newSeverityCounts).toEqual({
        CRITICAL: 0,
        HIGH: 1,
        MEDIUM: 1,
        LOW: 0,
      });
      expect(result.summary.fixedSeverityCounts).toEqual({
        CRITICAL: 0,
        HIGH: 1,
        MEDIUM: 0,
        LOW: 0,
      });
      expect(result.summary.unchangedSeverityCounts).toEqual({
        CRITICAL: 1,
        HIGH: 0,
        MEDIUM: 0,
        LOW: 1,
      });
    });

    it("handles whitespace or empty fingerprints safely without false matches", () => {
      const fBaseNoFp = makeFinding({ id: "f-b-nofp", fingerprint: "  " });
      const fTargetNoFp = makeFinding({ id: "f-t-nofp", fingerprint: "" });

      const base = makeScan({ id: "scan-base", findings: [fBaseNoFp] });
      const target = makeScan({ id: "scan-target", findings: [fTargetNoFp] });

      const result = compareScans(base, target);

      expect(result.isComparable).toBe(true);
      // Because neither has a valid fingerprint, target is classified as new and base is fixed
      expect(result.summary.newCount).toBe(1);
      expect(result.summary.fixedCount).toBe(1);
      expect(result.summary.unchangedCount).toBe(0);
    });
  });

  describe("computeSeverityCounts", () => {
    it("aggregates counts case-insensitively and handles missing or custom severities", () => {
      const findings: ScanFindingItem[] = [
        makeFinding({ severity: "CRITICAL" }),
        makeFinding({ severity: "critical" }),
        makeFinding({ severity: "HIGH" }),
        makeFinding({ severity: "medium" }),
        makeFinding({ severity: "LOW" }),
      ];

      const counts = computeSeverityCounts(findings);
      expect(counts.CRITICAL).toBe(2);
      expect(counts.HIGH).toBe(1);
      expect(counts.MEDIUM).toBe(1);
      expect(counts.LOW).toBe(1);
    });
  });
});
