/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import AiHealthDashboardPage, { metadata } from "./page";
import AiHealthLoading from "./loading";
import * as authModule from "@/auth";
import * as telemetryModule from "@/ai/telemetry";
import { redirect } from "next/navigation";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/ai/telemetry", () => ({
  getAiHealthReport: vi.fn(),
}));

vi.mock("./ai-health-client", () => ({
  default: ({ initialData, isAdmin }: { initialData: any; isAdmin: boolean }) => (
    <div data-testid="ai-health-client">
      <div data-testid="is-admin">{isAdmin ? "admin" : "user"}</div>
      <div data-testid="active-provider">{initialData?.primaryModel}</div>
      <div data-testid="active-model">{initialData?.primaryModel}</div>
      <div data-testid="overall-status">{initialData?.primaryTripped ? "degraded" : "healthy"}</div>
      <div data-testid="models-count">{initialData?.models?.length ?? 0}</div>
      <div data-testid="failovers-count">{initialData?.recentFailovers?.length ?? 0}</div>
      <div data-testid="total-invocations">{initialData?.totalRequests ?? 0}</div>
      <div data-testid="total-failures">{initialData?.totalErrors ?? 0}</div>
      <div data-testid="avg-latency">{initialData?.models?.[0]?.avgLatencyMs ?? 0}</div>
    </div>
  ),
}));

describe("AiHealthDashboardPage Server Component (#1498)", () => {
  const mockReport: telemetryModule.AiHealthReport = {
    timestamp: 1730000000000,
    primaryModel: "groq/llama-3.3-70b-versatile",
    primaryTripped: false,
    totalRequests: 170,
    totalErrors: 2,
    totalFailovers: 1,
    overallErrorRate: 1.2,
    models: [
      {
        modelName: "groq/llama-3.3-70b-versatile",
        displayName: "Groq: llama-3.3-70b-versatile",
        isPrimary: true,
        isLocal: false,
        circuitState: "CLOSED",
        isHealthy: true,
        failureCount: 0,
        failureThreshold: 5,
        resetTimeoutMs: 30000,
        nextAttemptTimestamp: 0,
        totalRequests: 150,
        totalSuccesses: 148,
        totalErrors: 2,
        errorRate: 1.3,
        avgLatencyMs: 420,
        p95LatencyMs: 580,
        minLatencyMs: 200,
        maxLatencyMs: 800,
        recentLatencies: [],
      },
      {
        modelName: "groq/gemini-2.0-flash",
        displayName: "Groq: gemini-2.0-flash",
        isPrimary: false,
        isLocal: false,
        circuitState: "CLOSED",
        isHealthy: true,
        failureCount: 0,
        failureThreshold: 5,
        resetTimeoutMs: 30000,
        nextAttemptTimestamp: 0,
        totalRequests: 20,
        totalSuccesses: 20,
        totalErrors: 0,
        errorRate: 0,
        avgLatencyMs: 310,
        p95LatencyMs: 410,
        minLatencyMs: 150,
        maxLatencyMs: 500,
        recentLatencies: [],
      },
    ],
    recentFailovers: [
      {
        id: "failover-1",
        timestamp: 1730000000000,
        fromModel: "groq/llama-3.3-70b-versatile",
        toModel: "groq/gemini-2.0-flash",
        error: "Rate limit exceeded (HTTP 429)",
        attempt: 1,
        fastFail: false,
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports correct page metadata", () => {
    expect(metadata.title).toBe("AI Model & Circuit Breaker Health | SecureFlow");
    expect(metadata.description).toContain(
      "Real-time telemetry, sliding-window latency, and circuit breaker resilience monitoring",
    );
  });

  it("redirects unauthenticated users to /login when session is missing", async () => {
    vi.mocked(authModule.auth).mockResolvedValue(null as any);

    await expect(AiHealthDashboardPage()).rejects.toThrow("REDIRECT:/login");
    expect(redirect).toHaveBeenCalledWith("/login");
    expect(telemetryModule.getAiHealthReport).not.toHaveBeenCalled();
  });

  it("redirects unauthenticated users when session.user.id is absent", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({ user: {} } as any);

    await expect(AiHealthDashboardPage()).rejects.toThrow("REDIRECT:/login");
    expect(redirect).toHaveBeenCalledWith("/login");
    expect(telemetryModule.getAiHealthReport).not.toHaveBeenCalled();
  });

  it("fetches telemetry report and passes isAdmin: false for standard authenticated users", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", roles: ["USER"] },
    } as any);
    vi.mocked(telemetryModule.getAiHealthReport).mockResolvedValue(mockReport);

    const jsx = await AiHealthDashboardPage();
    render(jsx);

    expect(screen.getByTestId("ai-health-client")).toBeInTheDocument();
    expect(screen.getByTestId("is-admin")).toHaveTextContent("user");
    expect(screen.getByTestId("active-provider")).toHaveTextContent("groq/llama-3.3-70b-versatile");
    expect(screen.getByTestId("active-model")).toHaveTextContent("groq/llama-3.3-70b-versatile");
    expect(screen.getByTestId("overall-status")).toHaveTextContent("healthy");
    expect(screen.getByTestId("models-count")).toHaveTextContent("2");
    expect(screen.getByTestId("failovers-count")).toHaveTextContent("1");
    expect(screen.getByTestId("total-invocations")).toHaveTextContent("170");
    expect(screen.getByTestId("total-failures")).toHaveTextContent("2");
    expect(screen.getByTestId("avg-latency")).toHaveTextContent("420");
  });

  it("identifies ADMIN role correctly and passes isAdmin: true", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.com", roles: ["ADMIN"] },
    } as any);
    vi.mocked(telemetryModule.getAiHealthReport).mockResolvedValue(mockReport);

    const jsx = await AiHealthDashboardPage();
    render(jsx);

    expect(screen.getByTestId("is-admin")).toHaveTextContent("admin");
  });

  it("handles empty telemetry report data gracefully", async () => {
    const emptyReport: telemetryModule.AiHealthReport = {
      timestamp: 1730000000000,
      primaryModel: "none",
      primaryTripped: true,
      totalRequests: 0,
      totalErrors: 0,
      totalFailovers: 0,
      overallErrorRate: 0,
      models: [],
      recentFailovers: [],
    };

    vi.mocked(authModule.auth).mockResolvedValue({
      user: { id: "user-2", roles: ["DEVELOPER"] },
    } as any);
    vi.mocked(telemetryModule.getAiHealthReport).mockResolvedValue(emptyReport);

    const jsx = await AiHealthDashboardPage();
    render(jsx);

    expect(screen.getByTestId("is-admin")).toHaveTextContent("user");
    expect(screen.getByTestId("models-count")).toHaveTextContent("0");
    expect(screen.getByTestId("failovers-count")).toHaveTextContent("0");
    expect(screen.getByTestId("overall-status")).toHaveTextContent("degraded");
  });

  it("handles case when user has undefined roles array", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({
      user: { id: "user-no-roles" },
    } as any);
    vi.mocked(telemetryModule.getAiHealthReport).mockResolvedValue(mockReport);

    const jsx = await AiHealthDashboardPage();
    render(jsx);

    expect(screen.getByTestId("is-admin")).toHaveTextContent("user");
  });

  it("propagates telemetry service errors during server fetch", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({
      user: { id: "user-1", roles: [] },
    } as any);
    vi.mocked(telemetryModule.getAiHealthReport).mockRejectedValue(
      new Error("Telemetry store connection failed"),
    );

    await expect(AiHealthDashboardPage()).rejects.toThrow("Telemetry store connection failed");
  });

  describe("AiHealthLoading Skeleton Component", () => {
    it("renders loading skeleton with appropriate skeleton containers and cards", () => {
      render(<AiHealthLoading />);
      const container = screen.getByTestId("ai-health-loading");
      expect(container).toBeInTheDocument();
      expect(container.querySelectorAll(".glass-card").length).toBeGreaterThanOrEqual(5);
    });
  });
});
