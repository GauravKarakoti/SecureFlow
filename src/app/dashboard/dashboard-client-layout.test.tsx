/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { DashboardClientLayout } from "./dashboard-client-layout";
import * as nextAuth from "next-auth/react";

// Mock next-auth/react
vi.mock("next-auth/react", () => ({
  useSession: vi.fn(),
  signOut: vi.fn(),
}));

// Mock next/navigation
vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/dashboard"),
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  })),
}));

// Mock theme provider
vi.mock("@/components/theme-provider", () => ({
  useTheme: vi.fn(() => ({
    theme: "dark",
    toggleTheme: vi.fn(),
  })),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock VoiceAlertProvider to spy on props and isolate layout testing
vi.mock("@/components/audio/voice-alert-provider", () => ({
  VoiceAlertProvider: ({
    voiceAlertsEnabled,
    children,
  }: {
    voiceAlertsEnabled: boolean;
    children: React.ReactNode;
  }) => (
    <div data-testid="voice-alert-provider" data-voice-alerts-enabled={String(voiceAlertsEnabled)}>
      {children}
    </div>
  ),
}));

describe("DashboardClientLayout component (#1446)", () => {
  const mockUserSession = {
    user: {
      id: "usr-42",
      name: "Agent Cipher",
      email: "cipher@secureflow.test",
      codename: "CIPHER-01",
      image: "https://example.com/avatar.png",
      roles: ["SECURITY_ENGINEER"],
    },
    expires: "2099-01-01T00:00:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nextAuth.useSession).mockReturnValue({
      data: mockUserSession as any,
      status: "authenticated",
      update: vi.fn(),
    });
  });

  it("renders layout shell and children inside main element", () => {
    render(
      <DashboardClientLayout voiceAlertsEnabled={true}>
        <div data-testid="test-child">Child Content</div>
      </DashboardClientLayout>,
    );

    const child = screen.getByTestId("test-child");
    expect(child).toBeInTheDocument();
    expect(child.closest("main")).toHaveClass("flex-1", "overflow-y-auto");
  });

  it("passes voiceAlertsEnabled prop to VoiceAlertProvider", () => {
    const { rerender } = render(
      <DashboardClientLayout voiceAlertsEnabled={true}>
        <div>Body</div>
      </DashboardClientLayout>,
    );

    expect(screen.getByTestId("voice-alert-provider")).toHaveAttribute(
      "data-voice-alerts-enabled",
      "true",
    );

    rerender(
      <DashboardClientLayout voiceAlertsEnabled={false}>
        <div>Body</div>
      </DashboardClientLayout>,
    );

    expect(screen.getByTestId("voice-alert-provider")).toHaveAttribute(
      "data-voice-alerts-enabled",
      "false",
    );
  });

  it("renders desktop sidebar with expected navigation items", () => {
    render(
      <DashboardClientLayout voiceAlertsEnabled={false}>
        <div>Body</div>
      </DashboardClientLayout>,
    );

    // Desktop sidebar links
    expect(screen.getAllByText("Mission Control").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Breach Attempts").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Analytics").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Defense Strategy").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Vault Logs").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("System Status").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Settings").length).toBeGreaterThanOrEqual(1);
  });

  it("displays Admin Portal link in sidebar when user has ADMIN role", () => {
    vi.mocked(nextAuth.useSession).mockReturnValue({
      data: {
        ...mockUserSession,
        user: { ...mockUserSession.user, roles: ["ADMIN"] },
      } as any,
      status: "authenticated",
      update: vi.fn(),
    });

    render(
      <DashboardClientLayout voiceAlertsEnabled={false}>
        <div>Body</div>
      </DashboardClientLayout>,
    );

    expect(screen.getAllByText("Admin Portal").length).toBeGreaterThanOrEqual(1);
  });

  it("hides Admin Portal link when user does not have ADMIN role", () => {
    render(
      <DashboardClientLayout voiceAlertsEnabled={false}>
        <div>Body</div>
      </DashboardClientLayout>,
    );

    expect(screen.queryByText("Admin Portal")).not.toBeInTheDocument();
  });

  it("renders DashboardHeader with user credentials and logout button", () => {
    render(
      <DashboardClientLayout voiceAlertsEnabled={false}>
        <div>Body</div>
      </DashboardClientLayout>,
    );

    expect(screen.getByTitle("Log out")).toBeInTheDocument();
    expect(screen.getByLabelText("Open menu")).toBeInTheDocument();
  });

  it("controls MobileDrawer visibility via header menu and drawer close actions", () => {
    render(
      <DashboardClientLayout voiceAlertsEnabled={false}>
        <div>Body</div>
      </DashboardClientLayout>,
    );

    const openMenuBtn = screen.getByLabelText("Open menu");
    const closeMenuBtn = screen.getByLabelText("Close menu");

    // Drawer panel initially has translated offscreen class
    const drawerPanel = closeMenuBtn.closest(".fixed");
    expect(drawerPanel).toHaveClass("-translate-x-full");

    // Click hamburger menu to open drawer
    fireEvent.click(openMenuBtn);
    expect(drawerPanel).toHaveClass("translate-x-0");

    // Click close button to close drawer
    fireEvent.click(closeMenuBtn);
    expect(drawerPanel).toHaveClass("-translate-x-full");
  });

  it("renders cleanly when session is unauthenticated/null", () => {
    vi.mocked(nextAuth.useSession).mockReturnValue({
      data: null,
      status: "unauthenticated",
      update: vi.fn(),
    });

    expect(() =>
      render(
        <DashboardClientLayout voiceAlertsEnabled={false}>
          <div>Unauthenticated view</div>
        </DashboardClientLayout>,
      ),
    ).not.toThrow();

    expect(screen.getByText("Unauthenticated view")).toBeInTheDocument();
  });
});
