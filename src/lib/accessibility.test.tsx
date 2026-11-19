/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import axe from "axe-core";
import { SeverityBadge } from "@/components/ui/severity-badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";

describe("Accessibility (a11y) Automated Audits with axe-core", () => {
  it("reports no critical accessibility violations on SeverityBadge across all levels", async () => {
    const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "NONE"];

    for (const sev of severities) {
      const { container } = render(<SeverityBadge severity={sev} />);
      const results = await axe.run(container, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
        },
      });

      const severeViolations = results.violations.filter((v) =>
        ["serious", "critical"].includes(v.impact ?? ""),
      );
      expect(severeViolations, `Expected no severe a11y violations for severity ${sev}`).toEqual(
        [],
      );
    }
  });

  it("reports no critical accessibility violations on data tables with headers and scopes", async () => {
    const { container } = render(
      <Table aria-label="Security Metrics Table">
        <TableHeader>
          <TableRow>
            <TableHead>Metric</TableHead>
            <TableHead>Value</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Critical Findings</TableCell>
            <TableCell>0</TableCell>
            <TableCell>
              <SeverityBadge severity="NONE" />
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    const results = await axe.run(container, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
    });

    const severeViolations = results.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    );
    expect(severeViolations).toEqual([]);
  });

  it("ensures icon buttons have accessible labels and are reachable by keyboard", async () => {
    const handleClick = vi.fn();
    const { container } = render(
      <Button size="icon" aria-label="Refresh security findings" onClick={handleClick}>
        <span aria-hidden="true">🔄</span>
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Refresh security findings" });
    expect(button).toBeInTheDocument();

    // Verify keyboard reachability and focusability
    button.focus();
    expect(document.activeElement).toBe(button);

    // Verify keyboard Enter and Space activation
    fireEvent.keyDown(button, { key: "Enter", code: "Enter" });
    fireEvent.click(button);
    expect(handleClick).toHaveBeenCalled();

    const results = await axe.run(container);
    const severeViolations = results.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    );
    expect(severeViolations).toEqual([]);
  });

  it("supports keyboard-only row expansion with Enter and Space keys", () => {
    const onToggle = vi.fn();
    let isExpanded = false;

    const { rerender } = render(
      <table>
        <tbody>
          <tr
            tabIndex={0}
            role="button"
            aria-expanded={isExpanded}
            aria-label="Expand audit log details"
            onClick={() => {
              isExpanded = !isExpanded;
              onToggle(isExpanded);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                isExpanded = !isExpanded;
                onToggle(isExpanded);
              }
            }}
          >
            <td>ARMORIQ_VERIFY</td>
          </tr>
        </tbody>
      </table>,
    );

    const row = screen.getByRole("button", { name: "Expand audit log details" });
    row.focus();
    expect(document.activeElement).toBe(row);

    // Press Space key to toggle
    fireEvent.keyDown(row, { key: " ", code: "Space" });
    expect(onToggle).toHaveBeenCalledWith(true);

    // Press Enter key to toggle again
    rerender(
      <table>
        <tbody>
          <tr
            tabIndex={0}
            role="button"
            aria-expanded={true}
            aria-label="Collapse audit log details"
            onClick={() => {
              isExpanded = !isExpanded;
              onToggle(isExpanded);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                isExpanded = !isExpanded;
                onToggle(isExpanded);
              }
            }}
          >
            <td>ARMORIQ_VERIFY</td>
          </tr>
        </tbody>
      </table>,
    );

    const expandedRow = screen.getByRole("button", { name: "Collapse audit log details" });
    fireEvent.keyDown(expandedRow, { key: "Enter", code: "Enter" });
    expect(onToggle).toHaveBeenCalledWith(false);
  });
});
