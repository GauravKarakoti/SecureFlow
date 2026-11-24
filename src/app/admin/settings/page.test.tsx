/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminSettingsPage from "./page";
import * as installationSettingsActions from "@/lib/actions/installation-settings";

vi.mock("@/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "admin-1", roles: ["ADMIN"] } }),
}));

vi.mock("@/lib/actions/installation-settings", () => ({
  getInstallationSettings: vi.fn(),
  updateInstallationSettings: vi.fn(),
}));

vi.mock("./settings-client", () => ({
  default: ({ initialSettings }: { initialSettings: any }) => (
    <div data-testid="installation-settings-client">
      <h1>Installation Baseline Settings</h1>
      <div data-testid="gate-block-on">{initialSettings.gateBlockOn || "NONE"}</div>
      <div data-testid="locked-settings">{(initialSettings.lockedSettings || []).join(",")}</div>
    </div>
  ),
}));

describe("AdminSettingsPage (#2010)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads installation settings and renders client component", async () => {
    vi.mocked(installationSettingsActions.getInstallationSettings).mockResolvedValue({
      installationId: "default",
      gateBlockOn: "CRITICAL",
      gateReviewOn: "HIGH",
      minCommentConfidence: "MEDIUM",
      includeDefaults: true,
      skipDrafts: false,
      skipAuthors: [],
      lockedSettings: ["gateBlockOn"],
    });

    const pageElement = await AdminSettingsPage();
    render(pageElement);

    expect(screen.getByText("Installation Baseline Settings")).toBeDefined();
    expect(screen.getByTestId("gate-block-on").textContent).toBe("CRITICAL");
    expect(screen.getByTestId("locked-settings").textContent).toBe("gateBlockOn");
    expect(installationSettingsActions.getInstallationSettings).toHaveBeenCalledWith("default");
  });
});
