/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SettingsClient from "./settings-client";

const {
  toastSuccessMock,
  toastErrorMock,
  updateSlackWebhookMock,
  updateTeamsWebhookMock,
  testSlackWebhookMock,
  testTeamsWebhookMock,
  updateRepositoryPublicBadgeMock,
  updateWeeklyDigestPreferenceMock,
} = vi.hoisted(() => ({
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
  updateSlackWebhookMock: vi.fn(),
  updateTeamsWebhookMock: vi.fn(),
  testSlackWebhookMock: vi.fn(),
  testTeamsWebhookMock: vi.fn(),
  updateRepositoryPublicBadgeMock: vi.fn(),
  updateWeeklyDigestPreferenceMock: vi.fn(),
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
  updateRepositoryPublicBadge: updateRepositoryPublicBadgeMock,
  updateWeeklyDigestPreference: updateWeeklyDigestPreferenceMock,
}));

describe("SettingsClient component (#1333)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "location", {
      writable: true,
      value: { origin: "" },
    });
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

  it("renders repository status badges section with empty message when no repos", () => {
    render(
      <SettingsClient
        initialWebhookUrl=""
        initialVoiceAlertsEnabled={false}
        initialRepositories={[]}
      />,
    );

    expect(screen.getByText("Repository Status Badges")).toBeDefined();
    expect(
      screen.getByText(/No repositories connected yet. Sync your repositories/i),
    ).toBeDefined();
  });

  it("renders repositories and allows toggling public badge", async () => {
    updateRepositoryPublicBadgeMock.mockResolvedValueOnce({ success: true });

    render(
      <SettingsClient
        initialWebhookUrl=""
        initialVoiceAlertsEnabled={false}
        initialRepositories={[
          {
            id: "repo-1",
            fullName: "acme/repo-one",
            owner: "acme",
            publicBadgeEnabled: false,
          },
        ]}
      />,
    );

    expect(screen.getByText("acme/repo-one")).toBeDefined();
    expect(screen.getByText("Public badge disabled — returns neutral unknown badge")).toBeDefined();

    const switchToggle = screen.getByLabelText("Toggle public badge for acme/repo-one");
    fireEvent.click(switchToggle);

    await waitFor(() => {
      expect(updateRepositoryPublicBadgeMock).toHaveBeenCalledWith("repo-1", true);
      expect(toastSuccessMock).toHaveBeenCalledWith("Public status badge enabled.");
    });
  });

  it("renders badge preview and markdown copy button when badge is enabled", async () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: { origin: "https://secure-flow-six.vercel.app" },
    });
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });

    render(
      <SettingsClient
        initialWebhookUrl=""
        initialVoiceAlertsEnabled={false}
        initialRepositories={[
          {
            id: "repo-2",
            fullName: "acme/repo-two",
            owner: "acme",
            publicBadgeEnabled: true,
          },
        ]}
      />,
    );

    expect(screen.getByText("Public badge enabled — shows latest scan status")).toBeDefined();
    expect(screen.getByAltText("acme/repo-two badge").getAttribute("src")).toBe(
      "https://secure-flow-six.vercel.app/api/badge/acme/repo-two",
    );

    const copyBtn = screen.getByRole("button", { name: /Copy Markdown/i });
    fireEvent.click(copyBtn);

    expect(writeTextMock).toHaveBeenCalledWith(
      "[![SecureFlow Status](https://secure-flow-six.vercel.app/api/badge/acme/repo-two)](https://secure-flow-six.vercel.app)",
    );
    expect(toastSuccessMock).toHaveBeenCalledWith("Badge Markdown copied to clipboard!");
  });

  it("renders weekly digest card and allows toggling preference", async () => {
    updateWeeklyDigestPreferenceMock.mockResolvedValueOnce({
      success: true,
      enabled: false,
    });

    render(
      <SettingsClient
        initialWebhookUrl=""
        initialVoiceAlertsEnabled={false}
        initialWeeklyDigestEnabled={true}
      />,
    );

    expect(screen.getByText("Weekly Security Digest")).toBeDefined();
    const digestSwitch = screen.getByLabelText("Enable weekly security digest");
    expect(digestSwitch).toBeDefined();

    fireEvent.click(digestSwitch);

    await waitFor(() => {
      expect(updateWeeklyDigestPreferenceMock).toHaveBeenCalledWith(false);
      expect(toastSuccessMock).toHaveBeenCalledWith("Weekly security digest disabled.");
    });
  });

  it("handles weekly digest toggle error and reverts state", async () => {
    updateWeeklyDigestPreferenceMock.mockRejectedValueOnce(new Error("Network error"));

    render(
      <SettingsClient
        initialWebhookUrl=""
        initialVoiceAlertsEnabled={false}
        initialWeeklyDigestEnabled={true}
      />,
    );

    const digestSwitch = screen.getByLabelText("Enable weekly security digest");
    fireEvent.click(digestSwitch);

    await waitFor(() => {
      expect(updateWeeklyDigestPreferenceMock).toHaveBeenCalledWith(false);
      expect(toastErrorMock).toHaveBeenCalledWith("Network error");
    });
  });
});
