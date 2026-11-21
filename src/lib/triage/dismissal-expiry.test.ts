import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isSuppressionActive,
  activeSuppressionWhere,
  computeExpiryDate,
  getEndOfQuarter,
  isExpiringSoon,
  handleExpiredDismissals,
} from "./expiry";
import {
  buildFindingsWhere,
  normalizeFindingsQuery,
  fromSearchParams,
  toSearchParams,
} from "@/lib/findings/query";

describe("Dismissal Expiry End-to-End (#1890)", () => {
  const EXPIRY_DATE_STR = "2026-11-20T12:00:00.000Z";
  const EXPIRY_DATE = new Date(EXPIRY_DATE_STR);

  // Before: 2026-11-19
  const BEFORE_EXPIRY = new Date("2026-11-19T12:00:00.000Z");
  // On: 2026-11-20T12:00:00.000Z
  const ON_EXPIRY = new Date("2026-11-20T12:00:00.000Z");
  // After: 2026-11-21
  const AFTER_EXPIRY = new Date("2026-11-21T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Fixed clock suppression behavior: before, on, and after expiry date", () => {
    const dismissal = {
      status: "DISMISSED",
      expiresAt: EXPIRY_DATE,
    };

    it("before expiry date: dismissal actively suppresses the finding", () => {
      vi.setSystemTime(BEFORE_EXPIRY);
      const active = isSuppressionActive(dismissal, new Date());
      expect(active).toBe(true);
    });

    it("on expiry date (boundary condition): dismissal is expired and no longer suppresses the finding", () => {
      vi.setSystemTime(ON_EXPIRY);
      const active = isSuppressionActive(dismissal, new Date());
      expect(active).toBe(false);
    });

    it("after expiry date: dismissal is expired and no longer suppresses the finding", () => {
      vi.setSystemTime(AFTER_EXPIRY);
      const active = isSuppressionActive(dismissal, new Date());
      expect(active).toBe(false);
    });

    it("dismissals without an expiry date behave as today (permanently suppressed)", () => {
      const permanentDismissal = { status: "DISMISSED", expiresAt: null };
      vi.setSystemTime(BEFORE_EXPIRY);
      expect(isSuppressionActive(permanentDismissal, new Date())).toBe(true);

      vi.setSystemTime(AFTER_EXPIRY);
      expect(isSuppressionActive(permanentDismissal, new Date())).toBe(true);

      const legacyFP = { status: "FALSE_POSITIVE", expiresAt: undefined };
      expect(isSuppressionActive(legacyFP, new Date())).toBe(true);
    });
  });

  describe("Scan time auto-reopening and note attachment", () => {
    const mockTriage = {
      repositoryId: "repo-secureflow",
      fingerprint: "fp-abc-123",
      status: "DISMISSED",
      expiresAt: EXPIRY_DATE,
    };

    it("before expiry: does not auto-reopen and does not attach note", async () => {
      vi.setSystemTime(BEFORE_EXPIRY);
      const mockDb = {
        findingTriage: {
          findMany: vi.fn().mockResolvedValue([]),
          update: vi.fn(),
        },
        auditLog: { create: vi.fn() },
      };

      const findings = [
        {
          fingerprint: "fp-abc-123",
          explanation: "Hardcoded secret in config.ts",
          description: "Secret detected",
        },
      ];

      const res = await handleExpiredDismissals("repo-secureflow", findings, new Date(), {
        prismaClient: mockDb,
      });

      expect(res.reopenedCount).toBe(0);
      expect(mockDb.findingTriage.update).not.toHaveBeenCalled();
      expect(mockDb.auditLog.create).not.toHaveBeenCalled();
      expect(findings[0].explanation).toBe("Hardcoded secret in config.ts");
    });

    it("on expiry: treats as not suppressed, attaches note 'previous dismissal expired on DATE', reopens in DB, records audit log", async () => {
      vi.setSystemTime(ON_EXPIRY);
      const mockDb = {
        findingTriage: {
          findMany: vi.fn().mockResolvedValue([mockTriage]),
          update: vi.fn().mockResolvedValue({ id: "triage-1" }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      };

      const findings = [
        {
          fingerprint: "fp-abc-123",
          explanation: "Hardcoded secret in config.ts",
          description: "Secret detected",
        },
      ];

      const res = await handleExpiredDismissals("repo-secureflow", findings, new Date(), {
        prismaClient: mockDb,
        repoFullName: "GauravKarakoti/SecureFlow",
        userId: "user-owner",
      });

      expect(res.reopenedCount).toBe(1);
      expect(res.reopenedFingerprints).toContain("fp-abc-123");
      expect(findings[0].explanation).toContain("previous dismissal expired on 2026-11-20");
      expect(findings[0].description).toContain("previous dismissal expired on 2026-11-20");

      expect(mockDb.findingTriage.update).toHaveBeenCalledWith({
        where: {
          repositoryId_fingerprint: {
            repositoryId: "repo-secureflow",
            fingerprint: "fp-abc-123",
          },
        },
        data: expect.objectContaining({
          status: "OPEN",
          note: "previous dismissal expired on 2026-11-20",
          expiresAt: null,
        }),
      });

      expect(mockDb.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "FINDING AUTO-REOPENED",
          decision: "OPEN",
          resource: "GauravKarakoti/SecureFlow:fp-abc-123",
          metadata: expect.objectContaining({
            fingerprint: "fp-abc-123",
            reason: "Dismissal expired",
            note: "previous dismissal expired on 2026-11-20",
            autoReopened: true,
          }),
        }),
      });
    });

    it("after expiry: treats as not suppressed, attaches note, and logs auto-reopening", async () => {
      vi.setSystemTime(AFTER_EXPIRY);
      const mockDb = {
        findingTriage: {
          findMany: vi.fn().mockResolvedValue([mockTriage]),
          update: vi.fn().mockResolvedValue({ id: "triage-1" }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      };

      const findings = [
        {
          fingerprint: "fp-abc-123",
          explanation: "Hardcoded secret in config.ts",
          description: "Secret detected",
        },
      ];

      const res = await handleExpiredDismissals("repo-secureflow", findings, new Date(), {
        prismaClient: mockDb,
        repoFullName: "GauravKarakoti/SecureFlow",
      });

      expect(res.reopenedCount).toBe(1);
      expect(mockDb.findingTriage.update).toHaveBeenCalled();
      expect(mockDb.auditLog.create).toHaveBeenCalled();
    });
  });

  describe("Findings table filter 'expiring in 14 days'", () => {
    it("filters findings expiring within 14 days and includes dismissed in search", () => {
      const context = {
        userId: "user-123",
        dismissedFingerprints: ["fp-expiring-soon", "fp-expiring-later", "fp-permanent"],
        expiringFingerprints: ["fp-expiring-soon"],
      };

      const query = normalizeFindingsQuery({
        expiring: "14d",
      });

      const where = buildFindingsWhere(context, query);

      // Dismissed findings must NOT be blankly excluded when filtering for expiring dismissals
      expect(where.fingerprint).toBeUndefined();

      // Expiring fingerprints must be explicitly required in AND
      expect(where.AND).toEqual(
        expect.arrayContaining([{ fingerprint: { in: ["fp-expiring-soon"] } }]),
      );
    });

    it("round-trips expiring filter via search params", () => {
      const parsed = fromSearchParams({ expiring: "14d" });
      expect(parsed.expiring).toBe("14d");

      const qs = toSearchParams(parsed);
      expect(qs).toContain("expiring=14d");
    });
  });

  describe("Dismiss dialog quick choices calculation", () => {
    it("computes 30 days, 90 days, end of quarter, and custom date", () => {
      const now = new Date("2026-11-01T00:00:00.000Z");

      const thirty = computeExpiryDate("30", null, now);
      expect(thirty?.toISOString().slice(0, 10)).toBe("2026-12-01");

      const ninety = computeExpiryDate("90", null, now);
      expect(ninety?.toISOString().slice(0, 10)).toBe("2027-01-30");

      const quarter = computeExpiryDate("end_of_quarter", null, now);
      expect(quarter?.getFullYear()).toBe(2026);
      expect(quarter?.getMonth()).toBe(11); // December
      expect(quarter?.getDate()).toBe(31);

      const custom = computeExpiryDate("custom", "2027-01-15", now);
      expect(custom?.toISOString().slice(0, 10)).toBe("2027-01-15");
    });
  });
});
