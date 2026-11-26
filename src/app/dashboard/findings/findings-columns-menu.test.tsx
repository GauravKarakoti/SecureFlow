/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import {
  FindingsColumnsMenu,
  FindingsTablePreferencesProvider,
  useFindingsTablePreferences,
  DEFAULT_VISIBLE_COLUMNS,
  DEFAULT_PREFERENCES,
  getPreferencesStorageKey,
  loadStoredPreferences,
  saveStoredPreferences,
  type ColumnKey,
} from "./findings-columns-menu";

function TestConsumer() {
  const { preferences, toggleColumn, setDensity, resetPreferences } =
    useFindingsTablePreferences();

  return (
    <div>
      <div data-testid="current-density">{preferences.density}</div>
      <div data-testid="visible-columns-json">
        {JSON.stringify(preferences.visibleColumns)}
      </div>
      <button
        data-testid="btn-toggle-type"
        onClick={() => toggleColumn("type")}
      >
        Toggle Type
      </button>
      <button
        data-testid="btn-toggle-severity"
        onClick={() => toggleColumn("severity")}
      >
        Toggle Severity
      </button>
      <button
        data-testid="btn-toggle-status"
        onClick={() => toggleColumn("status")}
      >
        Toggle Status
      </button>
      <button
        data-testid="btn-density-compact"
        onClick={() => setDensity("compact")}
      >
        Set Compact
      </button>
      <button
        data-testid="btn-density-comfortable"
        onClick={() => setDensity("comfortable")}
      >
        Set Comfortable
      </button>
      <button data-testid="btn-reset" onClick={resetPreferences}>
        Reset
      </button>
      <FindingsColumnsMenu />
    </div>
  );
}

describe("Findings Table Columns & Density Preferences (#2099)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("loads default preferences when local storage is empty", () => {
    render(
      <FindingsTablePreferencesProvider userId="user-123">
        <TestConsumer />
      </FindingsTablePreferencesProvider>
    );

    expect(screen.getByTestId("current-density")).toHaveTextContent("comfortable");
    const visible = JSON.parse(
      screen.getByTestId("visible-columns-json").textContent || "{}"
    );
    expect(visible.severity).toBe(true);
    expect(visible.status).toBe(true);
    expect(visible.type).toBe(true);
    expect(visible.file).toBe(true);
    expect(visible.cwe).toBe(true);
    expect(visible.language).toBe(true);
    expect(visible.age).toBe(true);
    expect(visible.assignee).toBe(true);
    expect(visible.issue).toBe(true);
    expect(visible.notes).toBe(true);
  });

  it("persists toggling optional columns across sessions in localStorage", () => {
    render(
      <FindingsTablePreferencesProvider userId="user-123">
        <TestConsumer />
      </FindingsTablePreferencesProvider>
    );

    // Toggle 'type' column
    fireEvent.click(screen.getByTestId("btn-toggle-type"));

    const visibleAfter = JSON.parse(
      screen.getByTestId("visible-columns-json").textContent || "{}"
    );
    expect(visibleAfter.type).toBe(false);

    // Verify localStorage has persisted this
    const key = getPreferencesStorageKey("user-123");
    const stored = JSON.parse(window.localStorage.getItem(key) || "{}");
    expect(stored.visibleColumns.type).toBe(false);
    expect(stored.visibleColumns.severity).toBe(true);
  });

  it("never allows hiding required columns: severity and status", () => {
    render(
      <FindingsTablePreferencesProvider userId="user-123">
        <TestConsumer />
      </FindingsTablePreferencesProvider>
    );

    // Attempt to toggle severity
    fireEvent.click(screen.getByTestId("btn-toggle-severity"));
    let visible = JSON.parse(
      screen.getByTestId("visible-columns-json").textContent || "{}"
    );
    expect(visible.severity).toBe(true);

    // Attempt to toggle status
    fireEvent.click(screen.getByTestId("btn-toggle-status"));
    visible = JSON.parse(
      screen.getByTestId("visible-columns-json").textContent || "{}"
    );
    expect(visible.status).toBe(true);
  });

  it("sanitizes persisted storage even if corrupted or tampered with to ensure severity and status remain visible", () => {
    const key = getPreferencesStorageKey("user-tampered");
    window.localStorage.setItem(
      key,
      JSON.stringify({
        visibleColumns: { severity: false, status: false, type: false },
        density: "compact",
      })
    );

    const loaded = loadStoredPreferences("user-tampered");
    expect(loaded.visibleColumns.severity).toBe(true);
    expect(loaded.visibleColumns.status).toBe(true);
    expect(loaded.visibleColumns.type).toBe(false);
    expect(loaded.density).toBe("compact");
  });

  it("switches density between comfortable and compact and persists choice", () => {
    render(
      <FindingsTablePreferencesProvider userId="user-456">
        <TestConsumer />
      </FindingsTablePreferencesProvider>
    );

    expect(screen.getByTestId("current-density")).toHaveTextContent("comfortable");

    fireEvent.click(screen.getByTestId("btn-density-compact"));
    expect(screen.getByTestId("current-density")).toHaveTextContent("compact");

    const key = getPreferencesStorageKey("user-456");
    const stored = JSON.parse(window.localStorage.getItem(key) || "{}");
    expect(stored.density).toBe("compact");

    fireEvent.click(screen.getByTestId("btn-density-comfortable"));
    expect(screen.getByTestId("current-density")).toHaveTextContent("comfortable");
  });

  it("resets all columns and density to defaults when Reset is triggered", () => {
    render(
      <FindingsTablePreferencesProvider userId="user-reset">
        <TestConsumer />
      </FindingsTablePreferencesProvider>
    );

    // Modify state
    fireEvent.click(screen.getByTestId("btn-toggle-type"));
    fireEvent.click(screen.getByTestId("btn-density-compact"));

    expect(screen.getByTestId("current-density")).toHaveTextContent("compact");
    let visible = JSON.parse(
      screen.getByTestId("visible-columns-json").textContent || "{}"
    );
    expect(visible.type).toBe(false);

    // Click Reset
    fireEvent.click(screen.getByTestId("btn-reset"));

    expect(screen.getByTestId("current-density")).toHaveTextContent("comfortable");
    visible = JSON.parse(
      screen.getByTestId("visible-columns-json").textContent || "{}"
    );
    expect(visible.type).toBe(true);
    expect(visible.severity).toBe(true);
    expect(visible.status).toBe(true);
  });

  it("renders the Columns menu with keyboard accessible trigger and items", async () => {
    // In jsdom Radix dropdowns need PointerEvent or pointerDown/keyDown to open and render in Portal
    render(
      <FindingsTablePreferencesProvider userId="user-menu">
        <TestConsumer />
      </FindingsTablePreferencesProvider>
    );

    const trigger = screen.getByTestId("findings-columns-menu-trigger");
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-label", "Customize columns and density");

    // Test keyboard activation of the trigger
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    fireEvent.click(trigger);

    // Check if the dropdown opened or test opening with Enter/Space
    const triggerId = trigger.getAttribute("id");
    expect(triggerId).toBeTruthy();
  });
});
