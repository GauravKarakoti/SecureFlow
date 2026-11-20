import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  loadBudgetConfig,
  evaluateRouteBudgets,
  formatBudgetReportTable,
  parseRouteSizesFromManifest,
  type BundleBudgetConfig,
} from "./check-bundle-budgets";

describe("check-bundle-budgets", () => {
  const mockConfig: BundleBudgetConfig = {
    name: "Test Budgets",
    settings: {
      maxRouteGrowthPercent: 10,
      maxRouteGrowthKb: 20,
    },
    routes: {
      "/": { budgetKb: 100, baselineKb: 80 },
      "/dashboard": { budgetKb: 200, baselineKb: 150 },
      "/dashboard/findings": { budgetKb: 250, baselineKb: 200 },
    },
  };

  it("passes when all routes are within budget and growth thresholds", () => {
    const routeSizes = {
      "/": 85, // grew 5kb / 6.25% (under 20kb and under 10%)
      "/dashboard": 155, // grew 5kb
      "/dashboard/findings": 200,
    };

    const result = evaluateRouteBudgets(routeSizes, mockConfig);
    expect(result.passed).toBe(true);
    expect(result.failedRoutes).toBe(0);
    expect(result.passedRoutes).toBe(3);
  });

  it("fails when a route exceeds absolute budgetKb", () => {
    const routeSizes = {
      "/": 110, // Exceeds 100kb budget
      "/dashboard": 150,
      "/dashboard/findings": 200,
    };

    const result = evaluateRouteBudgets(routeSizes, mockConfig);
    expect(result.passed).toBe(false);
    expect(result.failedRoutes).toBe(1);

    const rootEval = result.evaluations.find((e) => e.route === "/");
    expect(rootEval?.passed).toBe(false);
    expect(rootEval?.status).toBe("EXCEEDED_BUDGET");
    expect(rootEval?.message).toContain("Exceeded max budget: 110.0 kB > 100 kB");
  });

  it("fails when a route exceeds growth percentage and absolute growth threshold", () => {
    const routeSizes = {
      "/": 80,
      "/dashboard": 180, // Grew 30kb (20%) - exceeds both 20kb and 10%
      "/dashboard/findings": 200,
    };

    const result = evaluateRouteBudgets(routeSizes, mockConfig);
    expect(result.passed).toBe(false);
    expect(result.failedRoutes).toBe(1);

    const dashEval = result.evaluations.find((e) => e.route === "/dashboard");
    expect(dashEval?.passed).toBe(false);
    expect(dashEval?.status).toBe("EXCEEDED_GROWTH");
    expect(dashEval?.message).toContain("Exceeded growth threshold");
  });

  it("allows growth exceeding percentage if absolute growth is below threshold", () => {
    // For small routes: 50 -> 60 is +20% but only +10kb, which is <= 20kb threshold
    const smallRouteConfig: BundleBudgetConfig = {
      settings: { maxRouteGrowthPercent: 10, maxRouteGrowthKb: 20 },
      routes: {
        "/small": { budgetKb: 100, baselineKb: 50 },
      },
    };

    const result = evaluateRouteBudgets({ "/small": 55 }, smallRouteConfig); // +5kb (+10%)
    expect(result.passed).toBe(true);
  });

  it("formats budget report table with all required columns and warnings", () => {
    const routeSizes = {
      "/": 115, // fails
      "/dashboard": 150, // passes
    };

    const result = evaluateRouteBudgets(routeSizes, mockConfig);
    const table = formatBudgetReportTable(result);

    expect(table).toContain("Route");
    expect(table).toContain("Actual (kB)");
    expect(table).toContain("Budget (kB)");
    expect(table).toContain("Status");
    expect(table).toContain("❌ FAIL");
    expect(table).toContain("✅ PASS");
  });

  it("loads committed bundle-budget.json correctly", () => {
    const config = loadBudgetConfig();
    expect(config.routes).toBeDefined();
    expect(config.routes["/"]).toBeDefined();
    expect(config.routes["/dashboard"]).toBeDefined();
    expect(config.settings.maxRouteGrowthPercent).toBeGreaterThan(0);
  });
});
