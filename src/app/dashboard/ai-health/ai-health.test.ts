import { getAiHealthReport, getModelDisplayName, DEFAULT_PRIMARY_GROQ_MODEL } from "@/ai/telemetry";
import { resetModelCircuitBreakers, tripModelCircuitBreaker, resetModelCircuitBreaker } from "@/ai/resilience";

describe("AI Health Dashboard Logic & Data Shaping", () => {
  beforeEach(async () => {
    resetModelCircuitBreakers();
  });

  it("should generate complete dashboard data with expected telemetry shape", async () => {
    const report = await getAiHealthReport();

    expect(report).toHaveProperty("timestamp");
    expect(report).toHaveProperty("primaryModel");
    expect(report).toHaveProperty("primaryTripped");
    expect(report).toHaveProperty("totalRequests");
    expect(report).toHaveProperty("totalErrors");
    expect(report).toHaveProperty("totalFailovers");
    expect(report).toHaveProperty("overallErrorRate");
    expect(report).toHaveProperty("models");
    expect(report).toHaveProperty("recentFailovers");

    expect(Array.isArray(report.models)).toBe(true);
    expect(report.models.length).toBeGreaterThanOrEqual(1);

    const primary = report.models.find((m) => m.isPrimary);
    expect(primary).toBeDefined();
    expect(primary?.circuitState).toBe("CLOSED");
    expect(primary?.isHealthy).toBe(true);
  });

  it("should correctly identify primary model tripped status when OPEN", async () => {
    tripModelCircuitBreaker(DEFAULT_PRIMARY_GROQ_MODEL);

    const report = await getAiHealthReport();
    expect(report.primaryTripped).toBe(true);

    const primary = report.models.find((m) => m.modelName === DEFAULT_PRIMARY_GROQ_MODEL || m.isPrimary);
    expect(primary?.circuitState).toBe("OPEN");
    expect(primary?.isHealthy).toBe(false);

    resetModelCircuitBreaker(DEFAULT_PRIMARY_GROQ_MODEL);
    const reportRecovered = await getAiHealthReport();
    expect(reportRecovered.primaryTripped).toBe(false);
  });

  it("should format display names for UI badges cleanly", () => {
    expect(getModelDisplayName("groq/openai/gpt-oss-20b")).toBe("Groq: OpenAI gpt-oss-20b");
    expect(getModelDisplayName("groq/openai/gpt-oss-120b")).toBe("Groq: OpenAI gpt-oss-120b");
    expect(getModelDisplayName("groq/qwen/qwen3.6-27b")).toBe("Groq: Qwen qwen3.6-27b");
    expect(getModelDisplayName("openai/qwen2.5-coder:7b")).toBe("Local AI: qwen2.5-coder:7b");
  });
});
