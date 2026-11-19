import { describe, it, expect } from "vitest";
import {
  calculateHealthScore,
  calculateHealthScoreBreakdown,
  calculateResolveTimePenalty,
  getHealthScoreTier,
  HEALTH_SCORE_FORMULA_DOCS,
  WEIGHTS,
  BASE_SCORE,
  type HealthScoreInput,
} from "./health-score";

describe("health-score engine (#1870)", () => {
  const cleanFindings = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  describe("repositories without scans", () => {
    it("returns null score and UNRANKED tier when hasScans is false", () => {
      const input: HealthScoreInput = {
        openFindings: cleanFindings,
        blockedPrsLast30Days: 0,
        medianResolveTimeMs: null,
        hasScans: false,
      };

      const breakdown = calculateHealthScoreBreakdown(input);
      expect(breakdown.score).toBeNull();
      expect(breakdown.tier).toBe("UNRANKED");
      expect(breakdown.totalDeductions).toBe(0);
      expect(calculateHealthScore(input)).toBeNull();
    });
  });

  describe("perfect repository", () => {
    it("returns 100 with EXCELLENT tier when clean", () => {
      const input: HealthScoreInput = {
        openFindings: cleanFindings,
        blockedPrsLast30Days: 0,
        medianResolveTimeMs: null,
        hasScans: true,
      };

      const breakdown = calculateHealthScoreBreakdown(input);
      expect(breakdown.score).toBe(100);
      expect(breakdown.tier).toBe("EXCELLENT");
      expect(breakdown.totalDeductions).toBe(0);
    });

    it("does not penalize fast resolution times (<= 2 days)", () => {
      const oneDayMs = 24 * 60 * 60 * 1000;
      const input: HealthScoreInput = {
        openFindings: cleanFindings,
        blockedPrsLast30Days: 0,
        medianResolveTimeMs: oneDayMs,
        hasScans: true,
      };

      const breakdown = calculateHealthScoreBreakdown(input);
      expect(breakdown.score).toBe(100);
      expect(breakdown.resolveTimePenalty).toBe(0);
    });
  });

  describe("findings penalty calculations", () => {
    it("deducts 15 points per critical finding up to 50 cap", () => {
      const oneCrit: HealthScoreInput = {
        openFindings: { ...cleanFindings, critical: 1 },
        blockedPrsLast30Days: 0,
        medianResolveTimeMs: null,
        hasScans: true,
      };
      expect(calculateHealthScore(oneCrit)).toBe(85);

      const twoCrit: HealthScoreInput = {
        openFindings: { ...cleanFindings, critical: 2 },
        blockedPrsLast30Days: 0,
        medianResolveTimeMs: null,
        hasScans: true,
      };
      expect(calculateHealthScore(twoCrit)).toBe(70);

      const fourCrit: HealthScoreInput = {
        openFindings: { ...cleanFindings, critical: 4 }, // 4 * 15 = 60, capped at 50
        blockedPrsLast30Days: 0,
        medianResolveTimeMs: null,
        hasScans: true,
      };
      const breakdown = calculateHealthScoreBreakdown(fourCrit);
      expect(breakdown.criticalPenalty).toBe(50);
      expect(breakdown.score).toBe(50);
    });

    it("deducts 8 points per high finding up to 30 cap", () => {
      const input: HealthScoreInput = {
        openFindings: { ...cleanFindings, high: 2 }, // 2 * 8 = 16
        blockedPrsLast30Days: 0,
        medianResolveTimeMs: null,
        hasScans: true,
      };
      expect(calculateHealthScore(input)).toBe(84);

      const cappedHigh: HealthScoreInput = {
        openFindings: { ...cleanFindings, high: 5 }, // 5 * 8 = 40, capped at 30
        blockedPrsLast30Days: 0,
        medianResolveTimeMs: null,
        hasScans: true,
      };
      const breakdown = calculateHealthScoreBreakdown(cappedHigh);
      expect(breakdown.highPenalty).toBe(30);
      expect(breakdown.score).toBe(70);
    });

    it("deducts 3 points per medium finding up to 15 cap", () => {
      const input: HealthScoreInput = {
        openFindings: { ...cleanFindings, medium: 3 }, // 3 * 3 = 9
        blockedPrsLast30Days: 0,
        medianResolveTimeMs: null,
        hasScans: true,
      };
      expect(calculateHealthScore(input)).toBe(91);

      const cappedMed: HealthScoreInput = {
        openFindings: { ...cleanFindings, medium: 10 }, // 10 * 3 = 30, capped at 15
        blockedPrsLast30Days: 0,
        medianResolveTimeMs: null,
        hasScans: true,
      };
      expect(calculateHealthScoreBreakdown(cappedMed).mediumPenalty).toBe(15);
    });

    it("deducts 1 point per low finding up to 5 cap", () => {
      const input: HealthScoreInput = {
        openFindings: { ...cleanFindings, low: 3 },
        blockedPrsLast30Days: 0,
        medianResolveTimeMs: null,
        hasScans: true,
      };
      expect(calculateHealthScore(input)).toBe(97);

      const cappedLow: HealthScoreInput = {
        openFindings: { ...cleanFindings, low: 20 },
        blockedPrsLast30Days: 0,
        medianResolveTimeMs: null,
        hasScans: true,
      };
      expect(calculateHealthScoreBreakdown(cappedLow).lowPenalty).toBe(5);
    });

    it("does not deduct points for info findings", () => {
      const input: HealthScoreInput = {
        openFindings: { ...cleanFindings, info: 50 },
        blockedPrsLast30Days: 0,
        medianResolveTimeMs: null,
        hasScans: true,
      };
      expect(calculateHealthScore(input)).toBe(100);
    });

    it("enforces max combined findings penalty of 80", () => {
      const maxedFindings: HealthScoreInput = {
        openFindings: {
          critical: 10, // 50
          high: 10, // 30
          medium: 10, // 15
          low: 10, // 5
          info: 10,
        }, // raw sum = 100, capped at 80
        blockedPrsLast30Days: 0,
        medianResolveTimeMs: null,
        hasScans: true,
      };
      const breakdown = calculateHealthScoreBreakdown(maxedFindings);
      expect(breakdown.findingsPenalty).toBe(80);
      expect(breakdown.score).toBe(20);
    });
  });

  describe("blocked pull requests penalty", () => {
    it("deducts 5 points per blocked PR in the last 30 days up to 20 cap", () => {
      const input: HealthScoreInput = {
        openFindings: cleanFindings,
        blockedPrsLast30Days: 2, // 2 * 5 = 10
        medianResolveTimeMs: null,
        hasScans: true,
      };
      expect(calculateHealthScore(input)).toBe(90);

      const cappedPrs: HealthScoreInput = {
        openFindings: cleanFindings,
        blockedPrsLast30Days: 6, // 6 * 5 = 30, capped at 20
        medianResolveTimeMs: null,
        hasScans: true,
      };
      const breakdown = calculateHealthScoreBreakdown(cappedPrs);
      expect(breakdown.blockedPrsPenalty).toBe(20);
      expect(breakdown.score).toBe(80);
    });
  });

  describe("resolution time penalty", () => {
    const day = 24 * 60 * 60 * 1000;

    it("applies penalty according to threshold tiers", () => {
      expect(calculateResolveTimePenalty(null)).toBe(0);
      expect(calculateResolveTimePenalty(day)).toBe(0); // 1d <= 2d
      expect(calculateResolveTimePenalty(2 * day)).toBe(0); // 2d <= 2d
      expect(calculateResolveTimePenalty(3 * day)).toBe(3); // 3d <= 7d
      expect(calculateResolveTimePenalty(7 * day)).toBe(3); // 7d <= 7d
      expect(calculateResolveTimePenalty(8 * day)).toBe(6); // 8d <= 14d
      expect(calculateResolveTimePenalty(14 * day)).toBe(6); // 14d <= 14d
      expect(calculateResolveTimePenalty(15 * day)).toBe(10); // > 14d
    });
  });

  describe("bounding and tier assignment", () => {
    it("clamps score to 0 when deductions exceed base score", () => {
      const worstCase: HealthScoreInput = {
        openFindings: {
          critical: 10,
          high: 10,
          medium: 10,
          low: 10,
          info: 0,
        }, // 80
        blockedPrsLast30Days: 10, // 20
        medianResolveTimeMs: 30 * 24 * 60 * 60 * 1000, // 10
        hasScans: true,
      }; // total deductions: 110
      const breakdown = calculateHealthScoreBreakdown(worstCase);
      expect(breakdown.totalDeductions).toBe(110);
      expect(breakdown.score).toBe(0);
      expect(breakdown.tier).toBe("AT_RISK");
    });

    it("maps scores to correct health tiers", () => {
      expect(getHealthScoreTier(null)).toBe("UNRANKED");
      expect(getHealthScoreTier(100)).toBe("EXCELLENT");
      expect(getHealthScoreTier(90)).toBe("EXCELLENT");
      expect(getHealthScoreTier(89)).toBe("GOOD");
      expect(getHealthScoreTier(75)).toBe("GOOD");
      expect(getHealthScoreTier(74)).toBe("NEEDS_ATTENTION");
      expect(getHealthScoreTier(50)).toBe("NEEDS_ATTENTION");
      expect(getHealthScoreTier(49)).toBe("AT_RISK");
      expect(getHealthScoreTier(0)).toBe("AT_RISK");
    });
  });

  describe("documentation consistency", () => {
    it("formula documentation accurately reflects constants", () => {
      expect(HEALTH_SCORE_FORMULA_DOCS.baseScore).toBe(BASE_SCORE);
      expect(HEALTH_SCORE_FORMULA_DOCS.maxFindingsPenalty).toBe(WEIGHTS.maxFindingsPenalty);
      expect(HEALTH_SCORE_FORMULA_DOCS.maxBlockedPrsPenalty).toBe(WEIGHTS.maxBlockedPrsPenalty);
      expect(HEALTH_SCORE_FORMULA_DOCS.rules.length).toBeGreaterThanOrEqual(6);
    });
  });
});
