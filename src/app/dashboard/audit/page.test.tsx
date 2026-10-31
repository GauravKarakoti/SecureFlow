/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import AuditPage from "./page";
import * as authModule from "@/auth";
import * as auditActions from "@/lib/actions/audit";
import prisma from "@/lib/prisma";
import { redirect } from "next/navigation";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    repository: {
      count: vi.fn(),
    },
    auditLog: {
      count: vi.fn(),
    },
  },
}));

vi.mock("@/lib/actions/audit", () => ({
  getUserAuditLogs: vi.fn(),
  getUserAuditLogFilters: vi.fn(),
}));

vi.mock("./audit-log-table", () => ({
  default: ({
    initialResult,
    actions,
    decisions,
    ownName,
  }: {
    initialResult: any;
    actions: string[];
    decisions: string[];
    ownName: string;
  }) => (
    <div data-testid="audit-log-table">
      <div data-testid="own-name">{ownName}</div>
      <div data-testid="total-logs">{initialResult.total}</div>
      <div data-testid="page-num">{initialResult.page}</div>
      <div data-testid="page-size">{initialResult.pageSize}</div>
      <div data-testid="actions-filter">{actions.join(",")}</div>
      <div data-testid="decisions-filter">{decisions.join(",")}</div>
      <div data-testid="logs-list">
        {initialResult.logs.map((log: any) => (
          <div key={log.id} data-testid="log-item">
            {log.action}:{log.resource}:{log.decision}
          </div>
        ))}
      </div>
    </div>
  ),
}));

describe("AuditPage Server Component (#1469)", () => {
  const mockLogsResult = {
    logs: [
      {
        id: "log-1",
        action: "finding.patch",
        resource: "finding:f-1",
        decision: "ALLOW",
        timestamp: new Date("2026-10-30T10:00:00Z"),
      },
      {
        id: "log-2",
        action: "policy.update",
        resource: "policy:p-12",
        decision: "BLOCK",
        timestamp: new Date("2026-10-30T11:00:00Z"),
      },
    ],
    total: 2,
    page: 1,
    pageSize: 10,
    totalPages: 1,
  };

  const mockFilters = {
    actions: ["finding.patch", "policy.update", "scan.trigger"],
    decisions: ["ALLOW", "BLOCK", "REVIEW"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects unauthenticated users to sign-in page", async () => {
    vi.mocked(authModule.auth).mockResolvedValue(null);

    await expect(AuditPage()).rejects.toThrow("REDIRECT:/api/auth/signin");
    expect(redirect).toHaveBeenCalledWith("/api/auth/signin");
  });

  it("redirects when session exists but user.id is absent", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({ user: {} } as any);

    await expect(AuditPage()).rejects.toThrow("REDIRECT:/api/auth/signin");
    expect(redirect).toHaveBeenCalledWith("/api/auth/signin");
  });

  it("renders audit page header, stat cards, and log table for authenticated user", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({
      user: { id: "user-audit-1", name: "Security Officer" },
    } as any);

    vi.mocked(auditActions.getUserAuditLogs).mockResolvedValue(mockLogsResult as any);
    vi.mocked(auditActions.getUserAuditLogFilters).mockResolvedValue(mockFilters as any);
    vi.mocked(prisma.repository.count).mockResolvedValue(5 as any);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(128 as any);

    const pageElement = await AuditPage();
    render(pageElement);

    expect(screen.getByRole("heading", { name: "Audit Logs" })).toBeInTheDocument();
    expect(
      screen.getByText("Comprehensive trail of all security decisions and system actions."),
    ).toBeInTheDocument();

    expect(screen.getByText("Monitored Repos")).toBeInTheDocument();
    expect(screen.getByText("5 Active")).toBeInTheDocument();

    expect(screen.getByText("System Actions")).toBeInTheDocument();
    expect(screen.getByText("128")).toBeInTheDocument();

    expect(auditActions.getUserAuditLogs).toHaveBeenCalledWith({ page: 1, pageSize: 10 });
    expect(auditActions.getUserAuditLogFilters).toHaveBeenCalledTimes(1);
    expect(prisma.repository.count).toHaveBeenCalledWith({
      where: { userId: "user-audit-1", isActive: true },
    });
    expect(prisma.auditLog.count).toHaveBeenCalledWith({
      where: {
        userId: "user-audit-1",
        timestamp: { gte: expect.any(Date) },
      },
    });

    expect(screen.getByTestId("own-name").textContent).toBe("Security Officer");
    expect(screen.getByTestId("total-logs").textContent).toBe("2");
    expect(screen.getByTestId("actions-filter").textContent).toBe(
      "finding.patch,policy.update,scan.trigger",
    );
    expect(screen.getByTestId("decisions-filter").textContent).toBe("ALLOW,BLOCK,REVIEW");

    const logItems = screen.getAllByTestId("log-item");
    expect(logItems).toHaveLength(2);
    expect(logItems[0].textContent).toBe("finding.patch:finding:f-1:ALLOW");
    expect(logItems[1].textContent).toBe("policy.update:policy:p-12:BLOCK");
  });

  it("falls back to user email when user name is not present", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({
      user: { id: "user-audit-2", email: "auditor@example.com" },
    } as any);

    vi.mocked(auditActions.getUserAuditLogs).mockResolvedValue(mockLogsResult as any);
    vi.mocked(auditActions.getUserAuditLogFilters).mockResolvedValue(mockFilters as any);
    vi.mocked(prisma.repository.count).mockResolvedValue(0 as any);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(0 as any);

    const pageElement = await AuditPage();
    render(pageElement);

    expect(screen.getByTestId("own-name").textContent).toBe("auditor@example.com");
  });

  it("falls back to 'You' when neither user name nor email is provided", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({
      user: { id: "user-audit-3" },
    } as any);

    vi.mocked(auditActions.getUserAuditLogs).mockResolvedValue(mockLogsResult as any);
    vi.mocked(auditActions.getUserAuditLogFilters).mockResolvedValue(mockFilters as any);
    vi.mocked(prisma.repository.count).mockResolvedValue(0 as any);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(0 as any);

    const pageElement = await AuditPage();
    render(pageElement);

    expect(screen.getByTestId("own-name").textContent).toBe("You");
  });
});
