import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isSuppressionActive,
  activeSuppressionWhere,
  validateExpiryDate,
  MAX_EXPIRY_DAYS,
  getEndOfQuarter,
  computeExpiryDate,
  isExpiringSoon,
  handleExpiredDismissals,
} from "./expiry";

describe("Triage Expiry Helper (#1503, #1890)", () => {
  const baseTime = new Date("2026-11-01T12:00:00.000Z");

  describe("isSuppressionActive", () => {
    it("returns false if candidate is null or undefined", () => {
      expect(isSuppressionActive(null, baseTime)).toBe(false);
      expect(isSuppressionActive(undefined, baseTime)).toBe(false);
    });

    it("returns false for non-suppressed statuses (OPEN, RESOLVED)", () => {
      expect(isSuppressionActive({ status: "OPEN" }, baseTime)).toBe(false);
      expect(isSuppressionActive({ status: "RESOLVED" }, baseTime)).toBe(false);
      expect(
        isSuppressionActive(
          { status: "OPEN", expiresAt: new Date("2026-11-10T00:00:00.000Z") },
          baseTime,
        ),
      ).toBe(false);
    });

    it("returns true for FALSE_POSITIVE or IGNORED with null or undefined expiresAt (never expires)", () => {
      expect(isSuppressionActive({ status: "FALSE_POSITIVE" }, baseTime)).toBe(true);
      expect(isSuppressionActive({ status: "IGNORED", expiresAt: null }, baseTime)).toBe(true);
      expect(
        isSuppressionActive({ status: "FALSE_POSITIVE", expiresAt: undefined }, baseTime),
      ).toBe(true);
    });

    it("returns true when expiresAt is in the future relative to injected clock", () => {
      const futureExpiry = new Date("2026-11-08T12:00:00.000Z"); // 7 days later
      expect(
        isSuppressionActive({ status: "FALSE_POSITIVE", expiresAt: futureExpiry }, baseTime),
      ).toBe(true);

      expect(
        isSuppressionActive({ status: "IGNORED", expiresAt: "2026-11-08T12:00:00.000Z" }, baseTime),
      ).toBe(true);
    });

    it("boundary condition: returns false when expiresAt equals now", () => {
      expect(
        isSuppressionActive(
          { status: "FALSE_POSITIVE", expiresAt: new Date("2026-11-01T12:00:00.000Z") },
          baseTime,
        ),
      ).toBe(false);
    });

    it("returns false when expiresAt is in the past relative to injected clock (expired dismissal)", () => {
      const pastExpiry = new Date("2026-10-31T12:00:00.000Z"); // 1 day before
      expect(
        isSuppressionActive({ status: "FALSE_POSITIVE", expiresAt: pastExpiry }, baseTime),
      ).toBe(false);
      expect(isSuppressionActive({ status: "IGNORED", expiresAt: pastExpiry }, baseTime)).toBe(
        false,
      );
    });

    it("returns false safely when expiresAt string is unparseable", () => {
      expect(
        isSuppressionActive({ status: "FALSE_POSITIVE", expiresAt: "not-a-valid-date" }, baseTime),
      ).toBe(false);
    });
  });

  describe("activeSuppressionWhere", () => {
    it("generates correct Prisma where fragment matching unexpired or null-expiry dismissals", () => {
      const fragment = activeSuppressionWhere(baseTime);
      expect(fragment).toEqual({
        status: { in: ["FALSE_POSITIVE", "IGNORED", "DISMISSED"] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: baseTime } }],
      });
    });
  });

  describe("validateExpiryDate", () => {
    it("accepts null, undefined or empty string as clearing expiry", () => {
      expect(validateExpiryDate(null, baseTime)).toEqual({ ok: true, expiresAt: null });
      expect(validateExpiryDate(undefined, baseTime)).toEqual({ ok: true, expiresAt: null });
      expect(validateExpiryDate("", baseTime)).toEqual({ ok: true, expiresAt: null });
    });

    it("accepts valid future date within 365 days", () => {
      const validDate = new Date("2026-11-08T12:00:00.000Z");
      const res = validateExpiryDate(validDate, baseTime);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.expiresAt).toEqual(validDate);
      }
    });

    it("rejects invalid date format", () => {
      const res = validateExpiryDate("invalid-date-string", baseTime);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe("Invalid expiry date format");
      }
    });

    it("rejects date in the past", () => {
      const pastDate = new Date("2026-10-30T12:00:00.000Z");
      const res = validateExpiryDate(pastDate, baseTime);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe("Expiry date must be in the future");
      }
    });

    it("rejects date equal to now (boundary check)", () => {
      const equalDate = new Date("2026-11-01T12:00:00.000Z");
      const res = validateExpiryDate(equalDate, baseTime);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe("Expiry date must be in the future");
      }
    });

    it("rejects date more than 365 days out", () => {
      const farFuture = new Date(baseTime.getTime() + (MAX_EXPIRY_DAYS + 2) * 24 * 60 * 60 * 1000);
      const res = validateExpiryDate(farFuture, baseTime);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe("Expiry date cannot be more than 365 days in the future");
      }
    });
  });

  describe("getEndOfQuarter (#1890)", () => {
    it("returns Dec 31 for Q4 dates", () => {
      const q4Date = new Date("2026-11-20T10:00:00.000Z");
      const endOfQ4 = getEndOfQuarter(q4Date);
      expect(endOfQ4.getFullYear()).toBe(2026);
      expect(endOfQ4.getMonth()).toBe(11); // December (0-based)
      expect(endOfQ4.getDate()).toBe(31);
    });

    it("returns Mar 31 for Q1 dates", () => {
      const q1Date = new Date("2026-02-15T10:00:00.000Z");
      const endOfQ1 = getEndOfQuarter(q1Date);
      expect(endOfQ1.getFullYear()).toBe(2026);
      expect(endOfQ1.getMonth()).toBe(2); // March
      expect(endOfQ1.getDate()).toBe(31);
    });

    it("returns Jun 30 for Q2 dates", () => {
      const q2Date = new Date("2026-04-10T10:00:00.000Z");
      const endOfQ2 = getEndOfQuarter(q2Date);
      expect(endOfQ2.getFullYear()).toBe(2026);
      expect(endOfQ2.getMonth()).toBe(5); // June
      expect(endOfQ2.getDate()).toBe(30);
    });

    it("returns Sep 30 for Q3 dates", () => {
      const q3Date = new Date("2026-07-25T10:00:00.000Z");
      const endOfQ3 = getEndOfQuarter(q3Date);
      expect(endOfQ3.getFullYear()).toBe(2026);
      expect(endOfQ3.getMonth()).toBe(8); // September
      expect(endOfQ3.getDate()).toBe(30);
    });
  });

  describe("computeExpiryDate (#1890)", () => {
    it("handles 30 days quick choice", () => {
      const result = computeExpiryDate("30", null, baseTime);
      expect(result).not.toBeNull();
      expect(result!.getTime()).toBe(baseTime.getTime() + 30 * 24 * 60 * 60 * 1000);
    });

    it("handles 90 days quick choice", () => {
      const result = computeExpiryDate("90", null, baseTime);
      expect(result).not.toBeNull();
      expect(result!.getTime()).toBe(baseTime.getTime() + 90 * 24 * 60 * 60 * 1000);
    });

    it("handles end_of_quarter quick choice", () => {
      const result = computeExpiryDate("end_of_quarter", null, baseTime);
      expect(result).not.toBeNull();
      expect(result!.getMonth()).toBe(11);
      expect(result!.getDate()).toBe(31);
    });

    it("handles custom date selection", () => {
      const result = computeExpiryDate("custom", "2026-12-15", baseTime);
      expect(result).not.toBeNull();
      expect(result!.toISOString().slice(0, 10)).toBe("2026-12-15");
    });

    it("returns null for none or missing selection", () => {
      expect(computeExpiryDate("none", null, baseTime)).toBeNull();
      expect(computeExpiryDate(null, null, baseTime)).toBeNull();
      expect(computeExpiryDate("", null, baseTime)).toBeNull();
    });
  });

  describe("isExpiringSoon (#1890)", () => {
    it("returns true for date within 14 days", () => {
      const sevenDaysLater = new Date(baseTime.getTime() + 7 * 24 * 60 * 60 * 1000);
      expect(isExpiringSoon(sevenDaysLater, 14, baseTime)).toBe(true);
    });

    it("returns true for date exactly at 14 days boundary", () => {
      const fourteenDaysLater = new Date(baseTime.getTime() + 14 * 24 * 60 * 60 * 1000);
      expect(isExpiringSoon(fourteenDaysLater, 14, baseTime)).toBe(true);
    });

    it("returns false for date more than 14 days away", () => {
      const fifteenDaysLater = new Date(baseTime.getTime() + 15 * 24 * 60 * 60 * 1000);
      expect(isExpiringSoon(fifteenDaysLater, 14, baseTime)).toBe(false);
    });

    it("returns false for date in the past (already expired)", () => {
      const pastDate = new Date(baseTime.getTime() - 24 * 60 * 60 * 1000);
      expect(isExpiringSoon(pastDate, 14, baseTime)).toBe(false);
    });
  });

  describe("handleExpiredDismissals with fixed clock (#1890)", () => {
    const expiryTimestamp = new Date("2026-11-15T12:00:00.000Z");
    const mockTriage = {
      repositoryId: "repo-123",
      fingerprint: "fp-expired",
      status: "DISMISSED",
      expiresAt: expiryTimestamp,
    };

    it("before expiry date: dismissal is not expired, not auto-reopened", async () => {
      const beforeTime = new Date("2026-11-10T12:00:00.000Z");
      const mockDb = {
        findingTriage: {
          findMany: vi.fn().mockResolvedValue([]), // prisma where: expiresAt <= beforeTime returns nothing
          update: vi.fn(),
        },
        auditLog: { create: vi.fn() },
      };

      const findings = [
        { fingerprint: "fp-expired", explanation: "Risk in api.ts", description: "Secret found" },
      ];

      const res = await handleExpiredDismissals("repo-123", findings, beforeTime, {
        prismaClient: mockDb,
      });

      expect(res.reopenedCount).toBe(0);
      expect(mockDb.findingTriage.update).not.toHaveBeenCalled();
      expect(mockDb.auditLog.create).not.toHaveBeenCalled();
      expect(findings[0].explanation).toBe("Risk in api.ts");
    });

    it("on expiry date (now === expiresAt): dismissal is expired, auto-reopened, note attached, audit log created", async () => {
      const onTime = new Date("2026-11-15T12:00:00.000Z");
      const mockDb = {
        findingTriage: {
          findMany: vi.fn().mockResolvedValue([mockTriage]),
          update: vi.fn().mockResolvedValue({ id: "t1" }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "a1" }) },
      };

      const findings = [
        { fingerprint: "fp-expired", explanation: "Risk in api.ts", description: "Secret found" },
      ];

      const res = await handleExpiredDismissals("repo-123", findings, onTime, {
        prismaClient: mockDb,
        repoFullName: "org/repo",
        userId: "user-1",
      });

      expect(res.reopenedCount).toBe(1);
      expect(res.reopenedFingerprints).toContain("fp-expired");
      expect(findings[0].explanation).toContain("Note: previous dismissal expired on 2026-11-15");
      expect(findings[0].description).toContain("(previous dismissal expired on 2026-11-15)");

      expect(mockDb.findingTriage.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            repositoryId_fingerprint: {
              repositoryId: "repo-123",
              fingerprint: "fp-expired",
            },
          },
          data: expect.objectContaining({
            status: "OPEN",
            note: "previous dismissal expired on 2026-11-15",
          }),
        }),
      );

      expect(mockDb.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "FINDING AUTO-REOPENED",
            decision: "OPEN",
            metadata: expect.objectContaining({
              reason: "Dismissal expired",
              note: "previous dismissal expired on 2026-11-15",
            }),
          }),
        }),
      );
    });

    it("after expiry date: dismissal is expired, auto-reopened, note attached, audit log created", async () => {
      const afterTime = new Date("2026-11-20T12:00:00.000Z");
      const mockDb = {
        findingTriage: {
          findMany: vi.fn().mockResolvedValue([mockTriage]),
          update: vi.fn().mockResolvedValue({ id: "t1" }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "a1" }) },
      };

      const findings = [
        { fingerprint: "fp-expired", explanation: "Risk in api.ts", description: "Secret found" },
      ];

      const res = await handleExpiredDismissals("repo-123", findings, afterTime, {
        prismaClient: mockDb,
        repoFullName: "org/repo",
        userId: "user-1",
      });

      expect(res.reopenedCount).toBe(1);
      expect(mockDb.findingTriage.update).toHaveBeenCalled();
      expect(mockDb.auditLog.create).toHaveBeenCalled();
    });
  });
});
