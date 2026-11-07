import { expect, test } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import type { Result, NodeResult } from "axe-core";

/**
 * Known accessibility exceptions allow-list.
 * Each entry must be documented with an issue link and rationale.
 *
 * Example structure:
 * {
 *   ruleId: "color-contrast",
 *   selector: ".cyber-badge-dim",
 *   reason: "Low contrast neon cyber-theme badges scheduled for redesign",
 *   issue: "https://github.com/GauravKarakoti/SecureFlow/issues/1620",
 * }
 */
export interface AccessibilityException {
  ruleId: string;
  selector?: string;
  reason: string;
  issue: string;
}

export const KNOWN_A11Y_EXCEPTIONS: AccessibilityException[] = [
  // Documented allow-list items for existing known issues can be placed here.
  // Currently, the dashboard is evaluated for serious and critical violations.
];

/**
 * Filter out known allow-listed violations from axe results
 */
function filterAllowedViolations(
  violations: Result[],
  exceptions: AccessibilityException[],
): Result[] {
  return violations
    .map((violation) => {
      // If the rule is explicitly ignored for all selectors
      const ruleExceptions = exceptions.filter((e) => e.ruleId === violation.id);
      if (ruleExceptions.some((e) => !e.selector)) {
        return null;
      }

      // Filter nodes that match selectors in exceptions
      const remainingNodes = violation.nodes.filter((node: NodeResult) => {
        const targetString = Array.isArray(node.target)
          ? node.target.join(" ")
          : String(node.target);
        return !ruleExceptions.some((e) => e.selector && targetString.includes(e.selector));
      });

      if (remainingNodes.length === 0) {
        return null;
      }

      return {
        ...violation,
        nodes: remainingNodes,
      };
    })
    .filter((v): v is Result => v !== null);
}

test.describe("Mission Control Dashboard - Accessibility (a11y)", () => {
  const mainDashboardRoutes = [
    { name: "Mission Control (Overview)", path: "/dashboard" },
    { name: "Findings (Breach Attempts)", path: "/dashboard/findings" },
    { name: "Analytics", path: "/dashboard/analytics" },
    { name: "Policies (Defense Strategy)", path: "/dashboard/policies" },
    { name: "Audit Logs (Vault Logs)", path: "/dashboard/audit" },
    { name: "Admin Portal", path: "/admin" },
  ];

  for (const route of mainDashboardRoutes) {
    test(`accessibility check for ${route.name} (${route.path})`, async ({ page }) => {
      // Mock common API routes if necessary to allow complete layout rendering
      await page.route("**/api/audit/armoriq*", async (r) => {
        await r.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ traces: [], total: 0 }),
        });
      });

      await page.goto(route.path, { waitUntil: "domcontentloaded" });

      // Ensure page body has rendered
      await expect(page.locator("body")).toBeVisible({ timeout: 15_000 });

      // Run axe accessibility scan
      const accessibilityScanResults = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      // Only fail on 'serious' or 'critical' violations as per specification
      const severeViolations = accessibilityScanResults.violations.filter((v) =>
        ["serious", "critical"].includes(v.impact ?? ""),
      );

      const unhandledViolations = filterAllowedViolations(severeViolations, KNOWN_A11Y_EXCEPTIONS);

      // Detailed assertion error message if violations are found
      const violationSummary = unhandledViolations
        .map(
          (v) =>
            `[${v.impact?.toUpperCase()}] ${v.id}: ${v.help} (${v.helpUrl})\n` +
            v.nodes
              .map((n) => `  - Target: ${n.target.join(", ")}\n    HTML: ${n.html}`)
              .join("\n"),
        )
        .join("\n\n");

      expect(
        unhandledViolations,
        `Found serious/critical accessibility violations on ${route.path}:\n${violationSummary}`,
      ).toEqual([]);
    });
  }
});
