import { describe, expect, it } from "vitest";
import { evaluateFindingSla, evaluatePortfolioSla } from "./sla-escalation";

const NOW = new Date("2026-11-27T12:00:00.000Z");

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

describe("Triage SLA Aging & Breach-Escalation Engine", () => {
  it("classifies ON_TRACK, AT_RISK, BREACHED, CRITICAL_BREACH, and EXEMPT deterministically", () => {
    expect(
      evaluateFindingSla({ id: "1", severity: "CRITICAL", createdAt: hoursAgo(6) }, { now: NOW })
        .tier,
    ).toBe("ON_TRACK");

    expect(
      evaluateFindingSla({ id: "2", severity: "CRITICAL", createdAt: hoursAgo(18) }, { now: NOW })
        .tier,
    ).toBe("AT_RISK");

    const breached = evaluateFindingSla(
      { id: "3", severity: "CRITICAL", createdAt: hoursAgo(30) },
      { now: NOW },
    );
    expect(breached.tier).toBe("BREACHED");
    expect(breached.overdueHours).toBe(6);

    expect(
      evaluateFindingSla({ id: "4", severity: "CRITICAL", createdAt: hoursAgo(48) }, { now: NOW })
        .tier,
    ).toBe("CRITICAL_BREACH");

    expect(
      evaluateFindingSla(
        { id: "5", severity: "CRITICAL", status: "RESOLVED", createdAt: hoursAgo(100) },
        { now: NOW },
      ).tier,
    ).toBe("EXEMPT");
  });

  it("computes portfolio SLA compliance and sorts escalation queue by severity and elapsed ratio", () => {
    const summary = evaluatePortfolioSla(
      [
        { id: "low-breach", severity: "LOW", createdAt: hoursAgo(800) },
        { id: "crit-breach", severity: "CRITICAL", createdAt: hoursAgo(50) },
        { id: "high-risk", severity: "HIGH", createdAt: hoursAgo(60) },
        { id: "med-ok", severity: "MEDIUM", createdAt: hoursAgo(24) },
        {
          id: "closed-old",
          severity: "CRITICAL",
          status: "FALSE_POSITIVE",
          createdAt: hoursAgo(999),
        },
      ],
      { now: NOW },
    );

    expect(summary.totalFindings).toBe(5);
    expect(summary.exemptFindings).toBe(1);
    expect(summary.activeFindings).toBe(4);
    expect(summary.onTrackCount).toBe(1);
    expect(summary.atRiskCount).toBe(1);
    expect(summary.breachedCount).toBe(1);
    expect(summary.criticalBreachCount).toBe(1);
    expect(summary.slaCompliancePercentage).toBe(50);
    expect(summary.breachesBySeverity.CRITICAL).toBe(1);
    expect(summary.breachesBySeverity.LOW).toBe(1);

    expect(summary.escalationQueue.map((i) => i.findingId)).toEqual([
      "crit-breach",
      "high-risk",
      "low-breach",
    ]);
  });

  it("supports custom per-severity SLA budgets", () => {
    const res = evaluateFindingSla(
      { id: "custom-1", severity: "HIGH", createdAt: hoursAgo(10) },
      { now: NOW, budgetHours: { HIGH: 8 } },
    );
    expect(res.budgetHours).toBe(8);
    expect(res.tier).toBe("BREACHED");
    expect(res.overdueHours).toBe(2);
  });
});
