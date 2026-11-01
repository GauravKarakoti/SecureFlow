import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isSuppressionActive,
  activeSuppressionWhere,
  validateExpiryDate,
  MAX_EXPIRY_DAYS,
} from "./expiry";

describe("Triage Expiry Helper (#1503)", () => {
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
      expect(isSuppressionActive({ status: "FALSE_POSITIVE", expiresAt: undefined }, baseTime)).toBe(true);
    });

    it("returns true when expiresAt is in the future relative to injected clock", () => {
      const futureExpiry = new Date("2026-11-08T12:00:00.000Z"); // 7 days later
      expect(
        isSuppressionActive(
          { status: "FALSE_POSITIVE", expiresAt: futureExpiry },
          baseTime,
        ),
      ).toBe(true);

      expect(
        isSuppressionActive(
          { status: "IGNORED", expiresAt: "2026-11-08T12:00:00.000Z" },
          baseTime,
        ),
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
        isSuppressionActive(
          { status: "FALSE_POSITIVE", expiresAt: pastExpiry },
          baseTime,
        ),
      ).toBe(false);
      expect(
        isSuppressionActive(
          { status: "IGNORED", expiresAt: pastExpiry },
          baseTime,
        ),
      ).toBe(false);
    });

    it("returns false safely when expiresAt string is unparseable", () => {
      expect(
        isSuppressionActive(
          { status: "FALSE_POSITIVE", expiresAt: "not-a-valid-date" },
          baseTime,
        ),
      ).toBe(false);
    });
  });

  describe("activeSuppressionWhere", () => {
    it("generates correct Prisma where fragment matching unexpired or null-expiry dismissals", () => {
      const fragment = activeSuppressionWhere(baseTime);
      expect(fragment).toEqual({
        status: { in: ["FALSE_POSITIVE", "IGNORED"] },
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: baseTime } },
        ],
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
});

