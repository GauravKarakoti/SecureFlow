import { describe, expect, it } from "vitest";
import {
  BackpressureController,
  computeRetryAfterSeconds,
  evaluateBackpressureAdmission,
  resolveBackpressureState,
} from "./backpressure";
import { FairQueueScheduler } from "./fair-scheduler";

describe("Adaptive Watermark Backpressure Controller", () => {
  it("resolves backpressure states across watermark thresholds", () => {
    expect(resolveBackpressureState(200).state).toBe("normal");
    expect(resolveBackpressureState(600).state).toBe("elevated");
    expect(resolveBackpressureState(800).state).toBe("high");
    expect(resolveBackpressureState(950).state).toBe("critical");
  });

  it("escalates state when p95 latency exceeds configured thresholds", () => {
    expect(resolveBackpressureState(100, 6_000).state).toBe("elevated");
    expect(resolveBackpressureState(100, 16_000).state).toBe("high");
  });

  it("sheds lower priorities progressively across watermarks while preserving CRITICAL", () => {
    // Normal (depth 200 / 1000): all admitted
    expect(evaluateBackpressureAdmission({ currentDepth: 200, priority: "BATCH" }).admitted).toBe(
      true,
    );

    // Elevated (600 / 1000): LOW & BATCH shed, NORMAL admitted
    const elevatedBatch = evaluateBackpressureAdmission({ currentDepth: 600, priority: "BATCH" });
    expect(elevatedBatch.admitted).toBe(false);
    expect(elevatedBatch.reason).toBe("shed_elevated_watermark");
    expect(elevatedBatch.retryAfterSeconds).toBeGreaterThanOrEqual(5);

    expect(evaluateBackpressureAdmission({ currentDepth: 600, priority: "NORMAL" }).admitted).toBe(
      true,
    );

    // High (800 / 1000): NORMAL shed, HIGH admitted
    const highNormal = evaluateBackpressureAdmission({ currentDepth: 800, priority: "NORMAL" });
    expect(highNormal.admitted).toBe(false);
    expect(highNormal.reason).toBe("shed_high_watermark");

    expect(evaluateBackpressureAdmission({ currentDepth: 800, priority: "HIGH" }).admitted).toBe(
      true,
    );

    // Critical (950 / 1000): HIGH shed, CRITICAL admitted
    const criticalHigh = evaluateBackpressureAdmission({ currentDepth: 950, priority: "HIGH" });
    expect(criticalHigh.admitted).toBe(false);
    expect(criticalHigh.reason).toBe("shed_critical_watermark");

    const criticalJob = evaluateBackpressureAdmission({
      currentDepth: 990,
      priority: "CRITICAL",
    });
    expect(criticalJob.admitted).toBe(true);
    expect(criticalJob.retryAfterSeconds).toBe(0);
  });

  it("enforces per-installation quota under pressure except for CRITICAL jobs", () => {
    const shed = evaluateBackpressureAdmission({
      currentDepth: 650,
      installationDepth: 350,
      priority: "NORMAL",
    });
    expect(shed.admitted).toBe(false);
    expect(shed.reason).toBe("shed_installation_quota");

    const critical = evaluateBackpressureAdmission({
      currentDepth: 650,
      installationDepth: 350,
      priority: "CRITICAL",
    });
    expect(critical.admitted).toBe(true);
  });

  it("scales retryAfterSeconds monotonically and caps at maxRetryAfterSeconds", () => {
    const rElevated = computeRetryAfterSeconds(0.62, "elevated");
    const rHigh = computeRetryAfterSeconds(0.85, "high");
    const rCritical = computeRetryAfterSeconds(0.98, "critical");

    expect(rElevated).toBeLessThan(rHigh);
    expect(rHigh).toBeLessThanOrEqual(rCritical);
    expect(rCritical).toBeLessThanOrEqual(120);
  });

  it("tracks admitted and shed metrics on BackpressureController", () => {
    const controller = new BackpressureController({ maxQueueDepth: 10 });
    expect(controller.evaluateAdmission({ currentDepth: 2, priority: "NORMAL" }).admitted).toBe(
      true,
    );
    expect(controller.evaluateAdmission({ currentDepth: 9, priority: "NORMAL" }).admitted).toBe(
      false,
    );
    expect(controller.getMetrics()).toEqual({ admittedCount: 1, shedCount: 1 });
  });

  it("integrates with FairQueueScheduler.enqueueWithBackpressure", () => {
    const scheduler = new FairQueueScheduler({
      totalConcurrencyLimit: 0, // Keep jobs waiting so depth builds deterministically
      backpressure: { maxQueueDepth: 10 },
    });

    // Fill 6 jobs (60% -> elevated)
    for (let i = 0; i < 6; i++) {
      const res = scheduler.enqueueWithBackpressure({
        id: `job-${i}`,
        installationId: "inst-1",
        repositoryFullName: "org/repo",
        prNumber: i + 1,
        priority: "NORMAL",
      });
      expect(res.enqueued).toBe(true);
    }

    // At 6/10 (elevated), LOW job should be shed
    const lowRes = scheduler.enqueueWithBackpressure({
      id: "job-low",
      installationId: "inst-2",
      repositoryFullName: "org/repo",
      prNumber: 99,
      priority: "LOW",
    });
    expect(lowRes.enqueued).toBe(false);
    expect(lowRes.decision.state).toBe("elevated");

    // CRITICAL job still admitted
    const critRes = scheduler.enqueueWithBackpressure({
      id: "job-crit",
      installationId: "inst-2",
      repositoryFullName: "org/repo",
      prNumber: 100,
      priority: "CRITICAL",
    });
    expect(critRes.enqueued).toBe(true);
    expect(scheduler.getBackpressureStatus().metrics.shedCount).toBe(1);
  });
});
