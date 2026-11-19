/**
 * Unit tests for src/lib/findings/age.ts
 *
 * Covers all acceptance criteria:
 *  - Age computed from createdAt
 *  - Overdue badge logic (exactly at target, just over, no date)
 *  - Dismissed findings never count as overdue
 *  - Target parsing validates positive integers
 */

import { describe, it, expect } from "vitest";
import {
  findingAgeDays,
  isFindingOverdue,
  formatAgeDays,
  countOverdue,
  parseAgeTargetEnv,
  buildAgeTargets,
  DEFAULT_AGE_TARGETS,
} from "./age";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

const TARGETS = { CRITICAL: 3, HIGH: 14, MEDIUM: 30, LOW: 90, INFO: null };

// ─── findingAgeDays ───────────────────────────────────────────────────────────

describe("findingAgeDays", () => {
  it("returns null when createdAt is null", () => {
    expect(findingAgeDays(null)).toBeNull();
  });

  it("returns null when createdAt is undefined", () => {
    expect(findingAgeDays(undefined)).toBeNull();
  });

  it("returns 0 for a finding created right now", () => {
    const now = new Date();
    expect(findingAgeDays(now, now)).toBe(0);
  });

  it("returns 1 for a finding created exactly 24 h ago", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const created = new Date("2026-11-16T12:00:00Z");
    expect(findingAgeDays(created, now)).toBe(1);
  });

  it("floors fractional days (23 h 59 min → 0d)", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const created = new Date("2026-11-16T12:01:00Z"); // 23h59min ago
    expect(findingAgeDays(created, now)).toBe(0);
  });

  it("returns 21 for a three-week-old finding", () => {
    const now = new Date("2026-11-17T00:00:00Z");
    const created = new Date("2026-10-27T00:00:00Z");
    expect(findingAgeDays(created, now)).toBe(21);
  });
});

// ─── isFindingOverdue ─────────────────────────────────────────────────────────

describe("isFindingOverdue", () => {
  it("is NOT overdue when status is DISMISSED (regardless of age)", () => {
    const twoMonthsAgo = daysAgo(60);
    expect(isFindingOverdue("CRITICAL", twoMonthsAgo, "DISMISSED", TARGETS)).toBe(false);
  });

  it("is NOT overdue when createdAt is null", () => {
    expect(isFindingOverdue("CRITICAL", null, "OPEN", TARGETS)).toBe(false);
  });

  it("is NOT overdue when severity has no target (INFO)", () => {
    expect(isFindingOverdue("INFO", daysAgo(999), "OPEN", TARGETS)).toBe(false);
  });

  it("is NOT overdue at exactly the target day (boundary: age === target)", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    // Exactly 3 days ago — should NOT be overdue (strictly > target is overdue)
    const created = new Date("2026-11-14T12:00:00Z");
    expect(isFindingOverdue("CRITICAL", created, "OPEN", TARGETS, now)).toBe(false);
  });

  it("IS overdue one day past the target (boundary: age === target + 1)", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    // 4 days ago, target is 3
    const created = new Date("2026-11-13T12:00:00Z");
    expect(isFindingOverdue("CRITICAL", created, "OPEN", TARGETS, now)).toBe(true);
  });

  it("IS overdue for a HIGH finding open 15 days (target 14)", () => {
    const now = new Date("2026-11-17T00:00:00Z");
    const created = new Date("2026-11-02T00:00:00Z"); // 15 days
    expect(isFindingOverdue("HIGH", created, "OPEN", TARGETS, now)).toBe(true);
  });

  it("is NOT overdue for a HIGH finding open 14 days (target 14)", () => {
    const now = new Date("2026-11-17T00:00:00Z");
    const created = new Date("2026-11-03T00:00:00Z"); // 14 days
    expect(isFindingOverdue("HIGH", created, "OPEN", TARGETS, now)).toBe(false);
  });

  it("IS overdue for a MEDIUM finding open 31 days (target 30)", () => {
    const now = new Date("2026-11-17T00:00:00Z");
    const created = new Date("2026-10-17T00:00:00Z"); // 31 days
    expect(isFindingOverdue("MEDIUM", created, "OPEN", TARGETS, now)).toBe(true);
  });

  it("treats RESOLVED status as not dismissed (may still be overdue)", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const created = new Date("2026-11-13T12:00:00Z"); // 4 days (> 3)
    // RESOLVED is not "DISMISSED" so overdue logic applies normally
    expect(isFindingOverdue("CRITICAL", created, "RESOLVED", TARGETS, now)).toBe(true);
  });

  it("treats unknown severity (no target) as never overdue", () => {
    expect(isFindingOverdue("UNKNOWN_SEV", daysAgo(999), "OPEN", TARGETS)).toBe(false);
  });
});

// ─── formatAgeDays ───────────────────────────────────────────────────────────

describe("formatAgeDays", () => {
  it("returns '—' when createdAt is null", () => {
    expect(formatAgeDays(null)).toBe("—");
  });

  it("returns '0d' for today", () => {
    const now = new Date();
    expect(formatAgeDays(now, now)).toBe("0d");
  });

  it("returns '7d' for a week-old finding", () => {
    const now = new Date("2026-11-17T00:00:00Z");
    const created = new Date("2026-11-10T00:00:00Z");
    expect(formatAgeDays(created, now)).toBe("7d");
  });
});

// ─── countOverdue ────────────────────────────────────────────────────────────

describe("countOverdue", () => {
  const now = new Date("2026-11-17T12:00:00Z");

  const findings = [
    // Overdue CRITICAL (4d > 3)
    { severity: "CRITICAL", createdAt: new Date("2026-11-13T12:00:00Z"), triageStatus: "OPEN" },
    // Not overdue CRITICAL (3d = target, not > target)
    { severity: "CRITICAL", createdAt: new Date("2026-11-14T12:00:00Z"), triageStatus: "OPEN" },
    // Dismissed → never overdue
    { severity: "CRITICAL", createdAt: new Date("2026-10-01T12:00:00Z"), triageStatus: "DISMISSED" },
    // No date → not overdue
    { severity: "CRITICAL", createdAt: null, triageStatus: "OPEN" },
    // Overdue HIGH (15d > 14)
    { severity: "HIGH", createdAt: new Date("2026-11-02T12:00:00Z"), triageStatus: "OPEN" },
    // INFO → no target, never overdue
    { severity: "INFO", createdAt: new Date("2026-01-01T12:00:00Z"), triageStatus: "OPEN" },
  ];

  it("counts only overdue, non-dismissed findings", () => {
    expect(countOverdue(findings, TARGETS, now)).toBe(2);
  });

  it("returns 0 when all findings are dismissed", () => {
    const all = findings.map((f) => ({ ...f, triageStatus: "DISMISSED" }));
    expect(countOverdue(all, TARGETS, now)).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(countOverdue([], TARGETS, now)).toBe(0);
  });
});

// ─── parseAgeTargetEnv ───────────────────────────────────────────────────────

describe("parseAgeTargetEnv", () => {
  it("returns null for undefined (env var absent)", () => {
    expect(parseAgeTargetEnv(undefined, "VAR")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAgeTargetEnv("", "VAR")).toBeNull();
  });

  it("parses a valid positive integer", () => {
    expect(parseAgeTargetEnv("7", "VAR")).toBe(7);
  });

  it("throws for zero", () => {
    expect(() => parseAgeTargetEnv("0", "VAR")).toThrow();
  });

  it("throws for a negative number", () => {
    expect(() => parseAgeTargetEnv("-1", "VAR")).toThrow();
  });

  it("throws for a float", () => {
    expect(() => parseAgeTargetEnv("3.5", "VAR")).toThrow();
  });

  it("throws for a non-numeric string", () => {
    expect(() => parseAgeTargetEnv("abc", "VAR")).toThrow();
  });
});

// ─── buildAgeTargets ─────────────────────────────────────────────────────────

describe("buildAgeTargets", () => {
  it("uses defaults when env is empty", () => {
    const targets = buildAgeTargets({});
    expect(targets).toEqual(DEFAULT_AGE_TARGETS);
  });

  it("overrides CRITICAL from env", () => {
    const targets = buildAgeTargets({ FINDING_AGE_TARGET_CRITICAL: "1" });
    expect(targets.CRITICAL).toBe(1);
    expect(targets.HIGH).toBe(DEFAULT_AGE_TARGETS.HIGH);
  });

  it("sets INFO target to a number when env sets it", () => {
    const targets = buildAgeTargets({ FINDING_AGE_TARGET_INFO: "60" });
    expect(targets.INFO).toBe(60);
  });

  it("throws when an env var is invalid", () => {
    expect(() => buildAgeTargets({ FINDING_AGE_TARGET_HIGH: "not-a-number" })).toThrow();
  });

  it("empty-string env var keeps default", () => {
    const targets = buildAgeTargets({ FINDING_AGE_TARGET_CRITICAL: "" });
    expect(targets.CRITICAL).toBe(DEFAULT_AGE_TARGETS.CRITICAL);
  });
});
