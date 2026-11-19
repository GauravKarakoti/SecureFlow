/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import OutboundWebhooksCard from "./outbound-webhooks-card";
import * as settingsActions from "@/lib/actions/settings";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/lib/actions/settings", () => ({
  createOutboundWebhook: vi.fn(),
  deleteOutboundWebhook: vi.fn(),
  toggleOutboundWebhook: vi.fn(),
  getOutboundWebhookDeliveries: vi.fn(),
  testOutboundWebhook: vi.fn(),
}));

describe("OutboundWebhooksCard UI (#1866)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when no webhooks are provided", () => {
    render(<OutboundWebhooksCard initialWebhooks={[]} />);
    expect(screen.getByText("Outbound Webhooks")).toBeDefined();
    expect(screen.getByText(/No outbound webhooks configured/i)).toBeDefined();
  });

  it("renders list of webhooks with URLs and subscribed event badges", () => {
    const webhooks = [
      {
        id: "wh_1",
        url: "https://siem.example.com/hook",
        events: ["scan.completed", "scan.blocked"],
        description: "Splunk Ingestion",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        latestDelivery: {
          id: "del_1",
          event: "scan.completed",
          statusCode: 200,
          error: null,
          attempts: 1,
          deliveredAt: new Date(),
          createdAt: new Date(),
        },
      },
    ];

    render(<OutboundWebhooksCard initialWebhooks={webhooks} />);
    expect(screen.getByText("https://siem.example.com/hook")).toBeDefined();
    expect(screen.getByText("(Splunk Ingestion)")).toBeDefined();
    expect(screen.getByText("scan.completed")).toBeDefined();
    expect(screen.getByText("scan.blocked")).toBeDefined();
    expect(screen.getByText(/Last delivery: HTTP 200/i)).toBeDefined();
  });

  it("allows opening form, filling details, and creating new webhook with one-time secret notice", async () => {
    vi.mocked(settingsActions.createOutboundWebhook).mockResolvedValueOnce({
      success: true,
      webhook: {
        id: "wh_new",
        url: "https://webhook.site/test",
        events: ["scan.completed"],
        description: "Test Site",
        secret: "whsec_supersecretkey12345",
      },
    });

    render(<OutboundWebhooksCard initialWebhooks={[]} />);

    // Click Add Webhook
    fireEvent.click(screen.getByText("Add Webhook"));
    expect(screen.getByText("Register HTTPS Webhook Endpoint")).toBeDefined();

    // Fill form
    const urlInput = screen.getByPlaceholderText("https://api.example.com/webhooks/secureflow");
    fireEvent.change(urlInput, { target: { value: "https://webhook.site/test" } });

    // Submit form
    fireEvent.click(screen.getByText("Save Endpoint"));

    await waitFor(() => {
      expect(settingsActions.createOutboundWebhook).toHaveBeenCalledWith({
        url: "https://webhook.site/test",
        events: expect.arrayContaining(["scan.completed"]),
        description: undefined,
      });
      expect(screen.getByText("Webhook Signing Secret (Shown Once)")).toBeDefined();
      expect(screen.getByDisplayValue("whsec_supersecretkey12345")).toBeDefined();
    });
  });

  it("handles toggling webhook status", async () => {
    vi.mocked(settingsActions.toggleOutboundWebhook).mockResolvedValueOnce({
      success: true,
    });

    const webhooks = [
      {
        id: "wh_1",
        url: "https://siem.example.com/hook",
        events: ["scan.completed"],
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(<OutboundWebhooksCard initialWebhooks={webhooks} />);
    const toggle = screen.getByLabelText("Toggle webhook https://siem.example.com/hook");
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(settingsActions.toggleOutboundWebhook).toHaveBeenCalledWith("wh_1", false);
    });
  });

  it("handles testing webhook delivery", async () => {
    vi.mocked(settingsActions.testOutboundWebhook).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      attempts: 1,
    });

    const webhooks = [
      {
        id: "wh_1",
        url: "https://siem.example.com/hook",
        events: ["scan.completed"],
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(<OutboundWebhooksCard initialWebhooks={webhooks} />);
    const testButton = screen.getByRole("button", { name: /test/i });
    fireEvent.click(testButton);

    await waitFor(() => {
      expect(settingsActions.testOutboundWebhook).toHaveBeenCalledWith("wh_1");
      expect(toast.success).toHaveBeenCalledWith("Test ping succeeded (HTTP 200).");
    });
  });

  it("handles viewing delivery logs", async () => {
    vi.mocked(settingsActions.getOutboundWebhookDeliveries).mockResolvedValueOnce([
      {
        id: "del_1",
        webhookId: "wh_1",
        eventId: "evt_123",
        event: "scan.completed",
        statusCode: 200,
        error: null,
        attempts: 1,
        deliveredAt: new Date(),
        createdAt: new Date(),
      },
    ]);

    const webhooks = [
      {
        id: "wh_1",
        url: "https://siem.example.com/hook",
        events: ["scan.completed"],
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(<OutboundWebhooksCard initialWebhooks={webhooks} />);
    const logsButton = screen.getByRole("button", { name: /logs/i });
    fireEvent.click(logsButton);

    await waitFor(() => {
      expect(settingsActions.getOutboundWebhookDeliveries).toHaveBeenCalledWith("wh_1", 20);
      expect(screen.getByText("Recent Delivery Logs")).toBeDefined();
      expect(screen.getByText("HTTP 200")).toBeDefined();
      expect(screen.getByText(/1 attempt/i)).toBeDefined();
    });
  });
});
