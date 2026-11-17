/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import OnboardingChecklist, { ONBOARDING_DISMISS_KEY } from "./onboarding-checklist";
import type { OnboardingStatus } from "@/lib/actions/onboarding";

const { sendTestWebhookEventMock, toastSuccessMock, toastErrorMock, toastInfoMock } = vi.hoisted(
  () => ({
    sendTestWebhookEventMock: vi.fn(),
    toastSuccessMock: vi.fn(),
    toastErrorMock: vi.fn(),
    toastInfoMock: vi.fn(),
  }),
);

vi.mock("@/lib/actions/onboarding", () => ({
  sendTestWebhookEvent: sendTestWebhookEventMock,
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
    info: toastInfoMock,
  },
}));

// Mock next/link
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

describe("OnboardingChecklist component (#1787)", () => {
  const emptyStatus: OnboardingStatus = {
    appInstalled: false,
    repoConnected: false,
    webhookReceived: false,
    policyEnabled: false,
    firstScanCompleted: false,
    allComplete: false,
  };

  const partialStatus: OnboardingStatus = {
    appInstalled: true,
    repoConnected: true,
    webhookReceived: false,
    policyEnabled: true,
    firstScanCompleted: false,
    allComplete: false,
  };

  const allCompleteStatus: OnboardingStatus = {
    appInstalled: true,
    repoConnected: true,
    webhookReceived: true,
    policyEnabled: true,
    firstScanCompleted: true,
    allComplete: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  describe("Empty state (0 of 5 complete)", () => {
    it("renders all 5 steps in pending state with action buttons and 0 of 5 complete counter", () => {
      render(<OnboardingChecklist status={emptyStatus} githubAppUrl="/setup" />);

      expect(screen.getByTestId("onboarding-checklist")).toBeInTheDocument();
      expect(screen.getByText("Get Started with SecureFlow")).toBeInTheDocument();
      expect(screen.getByText("0 of 5 Complete")).toBeInTheDocument();

      // Check all 5 titles
      expect(screen.getByText("GitHub App installed")).toBeInTheDocument();
      expect(screen.getByText("At least one repository connected")).toBeInTheDocument();
      expect(screen.getByText("Webhook delivery received")).toBeInTheDocument();
      expect(screen.getByText("At least one policy enabled")).toBeInTheDocument();
      expect(screen.getByText("First scan completed")).toBeInTheDocument();

      // Action links/buttons
      expect(screen.getByRole("button", { name: /Install App/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Configure Policies/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Send Test Event/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /View Scans/i })).toBeInTheDocument();
    });
  });

  describe("Partial state", () => {
    it("renders completed badges for satisfied steps and action buttons for pending ones", () => {
      const onSyncMock = vi.fn().mockResolvedValue(undefined);

      render(
        <OnboardingChecklist
          status={partialStatus}
          onSyncRepositories={onSyncMock}
          githubAppUrl="/setup"
        />,
      );

      expect(screen.getByText("3 of 5 Complete")).toBeInTheDocument();

      // 3 steps are complete (appInstalled, repoConnected, policyEnabled)
      const doneBadges = screen.getAllByText("✓ Done");
      expect(doneBadges).toHaveLength(3);

      const pendingBadges = screen.getAllByText("Pending");
      expect(pendingBadges).toHaveLength(2);

      // Webhook and scan remain pending
      expect(screen.getByRole("button", { name: /Send Test Event/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /View Scans/i })).toBeInTheDocument();
    });
  });

  describe("All-complete state", () => {
    it("hides automatically and does not render when all steps are complete", () => {
      const { container } = render(
        <OnboardingChecklist status={allCompleteStatus} githubAppUrl="/setup" />,
      );

      expect(container.firstChild).toBeNull();
      expect(screen.queryByTestId("onboarding-checklist")).not.toBeInTheDocument();
    });
  });

  describe("Dismissal behavior", () => {
    it("dismisses when X button is clicked and stores preference in localStorage", () => {
      render(<OnboardingChecklist status={emptyStatus} />);

      const dismissBtn = screen.getByLabelText("Dismiss checklist");
      fireEvent.click(dismissBtn);

      expect(screen.queryByTestId("onboarding-checklist")).not.toBeInTheDocument();
      expect(window.localStorage.getItem(ONBOARDING_DISMISS_KEY)).toBe("true");
      expect(toastInfoMock).toHaveBeenCalledWith("Onboarding checklist dismissed.");
    });

    it("respects existing dismissal preference from localStorage on mount", () => {
      window.localStorage.setItem(ONBOARDING_DISMISS_KEY, "true");

      const { container } = render(<OnboardingChecklist status={partialStatus} />);

      expect(container.firstChild).toBeNull();
      expect(screen.queryByTestId("onboarding-checklist")).not.toBeInTheDocument();
    });
  });

  describe("Send test event interaction", () => {
    it("handles successful test event and marks webhook delivery as complete", async () => {
      sendTestWebhookEventMock.mockResolvedValueOnce({
        success: true,
        message: "Webhook delivery received and signature verified successfully!",
        deliveryId: "del-12345",
      });

      render(<OnboardingChecklist status={emptyStatus} />);

      const testBtn = screen.getByRole("button", { name: /Send Test Event/i });
      fireEvent.click(testBtn);

      await waitFor(() => {
        expect(sendTestWebhookEventMock).toHaveBeenCalled();
        expect(screen.getByTestId("test-event-result")).toBeInTheDocument();
        expect(screen.getByText("Test Event Verified")).toBeInTheDocument();
        expect(
          screen.getByText("Webhook delivery received and signature verified successfully!"),
        ).toBeInTheDocument();
        expect(toastSuccessMock).toHaveBeenCalledWith(
          "Webhook test delivery verified successfully!",
        );
      });

      // Progress advances from 0 to 1 of 5
      expect(screen.getByText("1 of 5 Complete")).toBeInTheDocument();
    });

    it("displays readable failure reason when test event fails", async () => {
      sendTestWebhookEventMock.mockResolvedValueOnce({
        success: false,
        error:
          "Configuration Error: GITHUB_WEBHOOK_SECRET is not configured on the server. Webhook deliveries cannot be validated.",
      });

      render(<OnboardingChecklist status={emptyStatus} />);

      const testBtn = screen.getByRole("button", { name: /Send Test Event/i });
      fireEvent.click(testBtn);

      await waitFor(() => {
        expect(sendTestWebhookEventMock).toHaveBeenCalled();
        expect(screen.getByTestId("test-event-result")).toBeInTheDocument();
        expect(screen.getByText("Test Event Failed")).toBeInTheDocument();
        expect(
          screen.getByText(
            "Configuration Error: GITHUB_WEBHOOK_SECRET is not configured on the server. Webhook deliveries cannot be validated.",
          ),
        ).toBeInTheDocument();
        expect(toastErrorMock).toHaveBeenCalledWith(
          "Configuration Error: GITHUB_WEBHOOK_SECRET is not configured on the server. Webhook deliveries cannot be validated.",
        );
      });
    });

    it("handles exceptions thrown during test event dispatch gracefully", async () => {
      sendTestWebhookEventMock.mockRejectedValueOnce(
        new Error("Connection refused: 502 Bad Gateway"),
      );

      render(<OnboardingChecklist status={emptyStatus} />);

      const testBtn = screen.getByRole("button", { name: /Send Test Event/i });
      fireEvent.click(testBtn);

      await waitFor(() => {
        expect(screen.getByTestId("test-event-result")).toBeInTheDocument();
        expect(screen.getByText("Test Event Failed")).toBeInTheDocument();
        expect(screen.getByText("Connection refused: 502 Bad Gateway")).toBeInTheDocument();
        expect(toastErrorMock).toHaveBeenCalledWith("Connection refused: 502 Bad Gateway");
      });
    });
  });
});
