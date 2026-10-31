/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import WebhookConfigCard from "./webhook-config-card";

const { toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}));

describe("WebhookConfigCard component (#1466)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders with default GitLab configuration tab", () => {
    render(<WebhookConfigCard baseUrl="https://secureflow.example.com" />);

    expect(screen.getByText("Inbound VCS Webhooks")).toBeInTheDocument();
    expect(screen.getByText("GitLab CI/CD")).toBeInTheDocument();
    expect(screen.getByText("Bitbucket Pipelines")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("https://secureflow.example.com/api/webhooks/gitlab"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Setup Instructions \(GitLab\)/i)).toBeInTheDocument();
  });

  it("switches to Bitbucket tab and displays Bitbucket endpoint and HMAC details", () => {
    render(<WebhookConfigCard baseUrl="https://secureflow.example.com" />);

    const bitbucketTab = screen.getByRole("tab", { name: /Bitbucket Pipelines/i });
    fireEvent.click(bitbucketTab);

    expect(
      screen.getByDisplayValue("https://secureflow.example.com/api/webhooks/bitbucket"),
    ).toBeInTheDocument();
    expect(screen.getByText(/HMAC Signature Verification/i)).toBeInTheDocument();
    expect(screen.getByText(/Setup Instructions \(Bitbucket\)/i)).toBeInTheDocument();
  });

  it("copies webhook URL to clipboard and triggers success toast", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(<WebhookConfigCard baseUrl="https://secureflow.example.com" />);

    const copyBtn = screen.getByRole("button", { name: /Copy/i });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("https://secureflow.example.com/api/webhooks/gitlab");
      expect(toastSuccessMock).toHaveBeenCalledWith("GitLab URL copied to clipboard.");
    });
  });

  it("copies header name to clipboard", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(<WebhookConfigCard baseUrl="https://secureflow.example.com" />);

    const headerCopyBtn = screen.getByRole("button", { name: /Header/i });
    fireEvent.click(headerCopyBtn);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("X-Gitlab-Token");
      expect(toastSuccessMock).toHaveBeenCalledWith("Header Name copied to clipboard.");
    });
  });
});
