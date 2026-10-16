import { describe, it, expect, beforeEach } from "vitest";
import {
  recordModelExecution,
  recordFailoverEvent,
  getAiHealthReport,
  clearTelemetry,
  getModelDisplayName,
  normalizeModelName,
  DEFAULT_PRIMARY_GROQ_MODEL,
} from "./telemetry";
import {
  getModelCircuitBreaker,
  resetModelCircuitBreakers,
  tripModelCircuitBreaker,
  resetModelCircuitBreaker,
} from "./resilience";

describe("AI Telemetry & Health Monitoring Engine", () => {
  beforeEach(async () => {
    resetModelCircuitBreakers();
    await clearTelemetry();
  });

  describe("Model Name Normalization and Display Formatting", () => {
    it("should normalize model names correctly", () => {
      expect(normalizeModelName("  groq/openai/gpt-oss-20b  ")).toBe("groq/openai/gpt-oss-20b");
      expect(normalizeModelName("openai/qwen2.5-coder:7b")).toBe("openai/qwen2.5-coder:7b");
    });

    it("should format display names with appropriate vendor badges", () => {
      expect(getModelDisplayName("groq/openai/gpt-oss-120b")).toBe("Groq: OpenAI gpt-oss-120b");
      expect(getModelDisplayName("groq/qwen/qwen3.6-27b")).toBe("Groq: Qwen qwen3.6-27b");
      expect(getModelDisplayName("groq/llama-3.1-8b-instant")).toBe("Groq: llama-3.1-8b-instant");
      expect(getModelDisplayName("openai/qwen2.5-coder:7b")).toBe("Local AI: qwen2.5-coder:7b");
    });
  });

  describe("Execution Latency and Counter Recording", () => {
    it("should record successful execution metrics and calculate averages", async () => {
      await recordModelExecution("groq/model-x", 120, true, 1);
      await recordModelExecution("groq/model-x", 180, true, 1);
      await recordModelExecution("groq/model-x", 300, true, 1);

      const report = await getAiHealthReport();
      const modelStat = report.models.find((m) => m.modelName === "groq/model-x");

      expect(modelStat).toBeDefined();
      expect(modelStat?.totalRequests).toBe(3);
      expect(modelStat?.totalSuccesses).toBe(3);
      expect(modelStat?.totalErrors).toBe(0);
      expect(modelStat?.errorRate).toBe(0);
      expect(modelStat?.avgLatencyMs).toBe(200);
      expect(modelStat?.minLatencyMs).toBe(120);
      expect(modelStat?.maxLatencyMs).toBe(300);
      expect(modelStat?.recentLatencies).toHaveLength(3);
    });

    it("should record error attempts and calculate error rate percentage", async () => {
      await recordModelExecution("groq/flaky-model", 100, true, 1);
      await recordModelExecution("groq/flaky-model", 200, false, 1, new Error("Rate limit 429"));
      await recordModelExecution("groq/flaky-model", 300, false, 2, new Error("Timeout 504"));

      const report = await getAiHealthReport();
      const modelStat = report.models.find((m) => m.modelName === "groq/flaky-model");

      expect(modelStat).toBeDefined();
      expect(modelStat?.totalRequests).toBe(3);
      expect(modelStat?.totalSuccesses).toBe(1);
      expect(modelStat?.totalErrors).toBe(2);
      expect(modelStat?.errorRate).toBeCloseTo(66.7, 1);
      expect(modelStat?.recentLatencies[0].success).toBe(false);
      expect(modelStat?.recentLatencies[0].error).toBe("Timeout 504");
    });
  });

  describe("Failover Transition Events", () => {
    it("should record failover switch events into chronological history", async () => {
      await recordFailoverEvent({
        fromModel: "groq/primary-a",
        toModel: "groq/secondary-b",
        error: new Error("Primary model rate limited"),
        attempt: 3,
        fastFail: false,
      });

      await recordFailoverEvent({
        fromModel: "groq/primary-a",
        toModel: "groq/secondary-b",
        error: "Circuit breaker OPEN",
        attempt: 0,
        fastFail: true,
      });

      const report = await getAiHealthReport();
      expect(report.recentFailovers).toHaveLength(2);
      expect(report.recentFailovers[0].fastFail).toBe(true);
      expect(report.recentFailovers[0].fromModel).toBe("groq/primary-a");
      expect(report.recentFailovers[0].toModel).toBe("groq/secondary-b");
      expect(report.recentFailovers[1].fastFail).toBe(false);
      expect(report.recentFailovers[1].attempt).toBe(3);
      expect(report.totalFailovers).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Circuit Breaker State Inspection & Alerts", () => {
    it("should flag primaryTripped when primary Groq breaker is OPEN", async () => {
      const reportBefore = await getAiHealthReport();
      expect(reportBefore.primaryTripped).toBe(false);

      // Manually trip the primary model
      tripModelCircuitBreaker(DEFAULT_PRIMARY_GROQ_MODEL);

      const reportAfter = await getAiHealthReport();
      expect(reportAfter.primaryTripped).toBe(true);
      const primaryStat = reportAfter.models.find(
        (m) => m.modelName === DEFAULT_PRIMARY_GROQ_MODEL || m.isPrimary,
      );
      expect(primaryStat?.circuitState).toBe("OPEN");
      expect(primaryStat?.isHealthy).toBe(false);

      // Reset breaker
      resetModelCircuitBreaker(DEFAULT_PRIMARY_GROQ_MODEL);
      const reportReset = await getAiHealthReport();
      expect(reportReset.primaryTripped).toBe(false);
    });
  });
});
