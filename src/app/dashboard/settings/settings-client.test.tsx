/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import SettingsClient from "./settings-client";

const {
  toastSuccessMock,
  toastErrorMock,
  updateSlackWebhookMock,
  updateTeamsWebhookMock,
  testSlackWebhookMock,
  testTeamsWebhookMock,
} = vi.hoisted(() => ({
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
  updateSlackWebhookMock: vi.fn(),
  updateTeamsWebhookMock: vi.fn(),
  testSlackWebhookMock: vi.fn(),
  testTeamsWebhookMock: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}));

vi.mock("@/lib/actions/settings", () => ({
  updateSlackWebhook: updateSlackWebhookMock,
  updateTeamsWebhook: updateTeamsWebhookMock,
  testSlackWebhook: testSlackWebhookMock,
  testTeamsWebhook: testTeamsWebhookMock,
  updateVoiceAlerts: vi.fn(),
}));

describe("SettingsClient component (#1333)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders with initial webhook URL", () => {
    render(
      <SettingsClient
        initialWebhookUrl="https://hooks.slack.com/services/initial"
        initialVoiceAlertsEnabled={false}
      />,
    );

    const input = screen.getByPlaceholderText(
      "https://hooks.slack.com/services/...",
    ) as HTMLInputElement;
    expect(input.value).toBe("https://hooks.slack.com/services/initial");
    expect(screen.getByRole("button", { name: /Save Settings/i })).toBeDefined();
  });

  it("renders with empty input when initialWebhookUrl is null", () => {
    render(<SettingsClient initialWebhookUrl={null} initialVoiceAlertsEnabled={false} />);

    const input = screen.getByPlaceholderText(
      "https://hooks.slack.com/services/...",
    ) as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("updates form input state when user types", () => {
    render(<SettingsClient initialWebhookUrl="" initialVoiceAlertsEnabled={false} />);

    const input = screen.getByPlaceholderText(
      "https://hooks.slack.com/services/...",
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: "https://hooks.slack.com/services/T00/B00/XXXXX" },
    });

    expect(input.value).toBe("https://hooks.slack.com/services/T00/B00/XXXXX");
  });

  it("submits updated webhook URL and displays success toast", async () => {
    updateSlackWebhookMock.mockResolvedValueOnce({ success: true });

    render(<SettingsClient initialWebhookUrl="" initialVoiceAlertsEnabled={false} />);

    const input = screen.getByPlaceholderText("https://hooks.slack.com/services/...");
    fireEvent.change(input, {
      target: { value: "https://hooks.slack.com/services/new-url" },
    });

    const saveButton = screen.getByRole("button", { name: /Save Settings/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(updateSlackWebhookMock).toHaveBeenCalledWith(
        "https://hooks.slack.com/services/new-url",
      );
      expect(toastSuccessMock).toHaveBeenCalledWith("Settings saved successfully.");
    });
  });

  it("displays error toast when update action fails", async () => {
    updateSlackWebhookMock.mockRejectedValueOnce(new Error("Invalid webhook URL format"));

    render(
      <SettingsClient
        initialWebhookUrl="https://hooks.slack.com/services/old"
        initialVoiceAlertsEnabled={false}
      />,
    );

    const saveButton = screen.getByRole("button", { name: /Save Settings/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(updateSlackWebhookMock).toHaveBeenCalledWith("https://hooks.slack.com/services/old");
      expect(toastErrorMock).toHaveBeenCalledWith("Invalid webhook URL format");
    });
  });

  it("submits updated Teams webhook URL and allows testing Teams webhook", async () => {
    updateTeamsWebhookMock.mockResolvedValueOnce({ success: true });
    testTeamsWebhookMock.mockResolvedValueOnce({ success: true });

    render(
      <SettingsClient
        initialWebhookUrl=""
        initialTeamsWebhookUrl="https://outlook.office.com/webhook/test"
        initialVoiceAlertsEnabled={false}
      />,
    );

    const teamsInput = screen.getByPlaceholderText(
      "https://outlook.office.com/webhook/...",
    ) as HTMLInputElement;
    expect(teamsInput.value).toBe("https://outlook.office.com/webhook/test");

    const saveTeamsButton = screen.getByRole("button", { name: /Save Teams Settings/i });
    fireEvent.click(saveTeamsButton);

    await waitFor(() => {
      expect(updateTeamsWebhookMock).toHaveBeenCalledWith(
        "https://outlook.office.com/webhook/test",
      );
      expect(toastSuccessMock).toHaveBeenCalledWith("Teams settings saved successfully.");
    });

    const testTeamsButton = screen.getByRole("button", { name: /Test Teams Webhook/i });
    fireEvent.click(testTeamsButton);

    await waitFor(() => {
      expect(testTeamsWebhookMock).toHaveBeenCalledWith("https://outlook.office.com/webhook/test");
      expect(toastSuccessMock).toHaveBeenCalledWith(
        "Microsoft Teams test notification sent successfully!",
      );
    });
  });

  it("allows testing Slack webhook", async () => {
    testSlackWebhookMock.mockResolvedValueOnce({ success: true });

    render(
      <SettingsClient
        initialWebhookUrl="https://hooks.slack.com/services/test"
        initialVoiceAlertsEnabled={false}
      />,
    );

    const testSlackButton = screen.getByRole("button", { name: /Test Webhook/i });
    fireEvent.click(testSlackButton);

    await waitFor(() => {
      expect(testSlackWebhookMock).toHaveBeenCalledWith("https://hooks.slack.com/services/test");
      expect(toastSuccessMock).toHaveBeenCalledWith("Slack test notification sent successfully!");
    });
  });
});
