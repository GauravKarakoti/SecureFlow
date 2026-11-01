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
  default: ({
    initialData,
    isAdmin,
  }: {
    initialData: any;
    isAdmin: boolean;
  }) => (
    <div data-testid="ai-health-client">
      <div data-testid="is-admin">{isAdmin ? "admin" : "user"}</div>
      <div data-testid="active-provider">{initialData?.activeProvider}</div>
      <div data-testid="active-model">{initialData?.activeModel}</div>
      <div data-testid="overall-status">{initialData?.overallStatus}</div>
      <div data-testid="models-count">{initialData?.models?.length ?? 0}</div>
      <div data-testid="failovers-count">{initialData?.recentFailovers?.length ?? 0}</div>
      <div data-testid="total-invocations">{initialData?.summary?.totalInvocations ?? 0}</div>
      <div data-testid="total-failures">{initialData?.summary?.totalFailures ?? 0}</div>
      <div data-testid="avg-latency">{initialData?.summary?.averageLatencyMs ?? 0}</div>
    </div>
  ),
}));

describe("AiHealthDashboardPage Server Component (#1498)", () => {
  const mockReport: telemetryModule.AiHealthReport = {
    activeProvider: "groq",
    activeModel: "llama-3.3-70b-versatile",
    overallStatus: "healthy",
    models: [
      {
        provider: "groq",
        modelId: "llama-3.3-70b-versatile",
        role: "primary",
        state: "CLOSED",
        failures: 0,
        consecutiveSuccesses: 15,
        totalRequests: 150,
        successfulRequests: 148,
        failedRequests: 2,
        failureRate: 0.013,
        lastFailureReason: null,
        lastStateChange: 1730000000000,
        averageLatencyMs: 420,
        slidingWindowLatencyP95: 580,
        slidingWindowLatencyP99: 720,
      },
      {
        provider: "google",
        modelId: "gemini-2.0-flash",
        role: "fallback",
        state: "CLOSED",
        failures: 0,
        consecutiveSuccesses: 5,
        totalRequests: 20,
        successfulRequests: 20,
        failedRequests: 0,
        failureRate: 0,
        lastFailureReason: null,
        lastStateChange: 1730000000000,
        averageLatencyMs: 310,
        slidingWindowLatencyP95: 410,
        slidingWindowLatencyP99: 490,
      },
    ],
    recentFailovers: [
      {
        timestamp: 1730000000000,
        fromModel: "llama-3.3-70b-versatile",
        toModel: "gemini-2.0-flash",
        reason: "Rate limit exceeded (HTTP 429)",
      },
    ],
    summary: {
      totalInvocations: 170,
      totalFailures: 2,
      averageLatencyMs: 407,
      openBreakers: 0,
      halfOpenBreakers: 0,
      closedBreakers: 2,
    },
    latencyTimeline: [],
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
    expect(screen.getByTestId("active-provider")).toHaveTextContent("groq");
    expect(screen.getByTestId("active-model")).toHaveTextContent("llama-3.3-70b-versatile");
    expect(screen.getByTestId("overall-status")).toHaveTextContent("healthy");
    expect(screen.getByTestId("models-count")).toHaveTextContent("2");
    expect(screen.getByTestId("failovers-count")).toHaveTextContent("1");
    expect(screen.getByTestId("total-invocations")).toHaveTextContent("170");
    expect(screen.getByTestId("total-failures")).toHaveTextContent("2");
    expect(screen.getByTestId("avg-latency")).toHaveTextContent("407");
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
      activeProvider: "none",
      activeModel: "none",
      overallStatus: "degraded",
      models: [],
      recentFailovers: [],
      summary: {
        totalInvocations: 0,
        totalFailures: 0,
        averageLatencyMs: 0,
        openBreakers: 0,
        halfOpenBreakers: 0,
        closedBreakers: 0,
      },
      latencyTimeline: [],
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
