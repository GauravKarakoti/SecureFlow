// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeliveriesClient } from "./deliveries-client";

describe("DeliveriesClient Component (#1928)", () => {
  const mockStats = {
    total: 4,
    queued: 1,
    scanned: 1,
    ignored: 1,
    rejected: 1,
  };

  const mockDeliveries = [
    {
      id: "del-1",
      deliveryId: "del-scanned-12345",
      eventType: "pull_request",
      action: "synchronize",
      repository: "acme/repo-a",
      outcome: "scanned",
      reasonCode: "SCANNED",
      error: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: "del-2",
      deliveryId: "del-queued-67890",
      eventType: "pull_request",
      action: "opened",
      repository: "acme/repo-b",
      outcome: "queued",
      reasonCode: "QUEUED",
      error: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: "del-3",
      deliveryId: "del-ignored-11111",
      eventType: "pull_request",
      action: "opened",
      repository: "acme/repo-c",
      outcome: "ignored",
      reasonCode: "DRAFT_PR",
      error: "Draft pull request skipped",
      createdAt: new Date().toISOString(),
    },
    {
      id: "del-4",
      deliveryId: "del-rejected-22222",
      eventType: "pull_request",
      action: null,
      repository: null,
      outcome: "rejected",
      reasonCode: "BAD_SIGNATURE",
      error: "Invalid GitHub webhook signature",
      createdAt: new Date().toISOString(),
    },
  ];

  it("renders metric cards with correct outcome counts", () => {
    render(
      <DeliveriesClient
        initialDeliveries={mockDeliveries}
        initialTotal={4}
        initialStats={mockStats}
        initialRepositories={["acme/repo-a", "acme/repo-b"]}
      />,
    );

    expect(screen.getByText("Total (7d)")).toBeInTheDocument();
    expect(screen.getAllByText("Scanned").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Queued").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Ignored").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Rejected").length).toBeGreaterThanOrEqual(2);
  });

  it("renders stable reason code badges for all outcomes", () => {
    render(
      <DeliveriesClient
        initialDeliveries={mockDeliveries}
        initialTotal={4}
        initialStats={mockStats}
        initialRepositories={["acme/repo-a", "acme/repo-b"]}
      />,
    );

    expect(screen.getAllByText("SCANNED")).toHaveLength(2); // desktop table + mobile card
    expect(screen.getAllByText("QUEUED")).toHaveLength(2);
    expect(screen.getAllByText("DRAFT_PR")).toHaveLength(2);
    expect(screen.getAllByText("BAD_SIGNATURE")).toHaveLength(2);
  });

  it("displays empty state when no deliveries exist", () => {
    render(
      <DeliveriesClient
        initialDeliveries={[]}
        initialTotal={0}
        initialStats={{ total: 0, queued: 0, scanned: 0, ignored: 0, rejected: 0 }}
        initialRepositories={[]}
      />,
    );

    expect(
      screen.getByText("No webhook deliveries recorded for the selected filters."),
    ).toBeInTheDocument();
  });
});
