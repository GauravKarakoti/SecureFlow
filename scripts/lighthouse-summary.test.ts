import { describe, it, expect } from "vitest";
import {
  loadLighthouseBudget,
  evaluateLighthouseScores,
  formatLighthouseMarkdownSummary,
  type LighthouseBudgetConfig,
} from "./lighthouse-summary";

describe("lighthouse-summary", () => {
  const mockBudget: LighthouseBudgetConfig = {
    pages: {
      "/api/auth/signin": {
        name: "Sign-in Page",
        minScores: {
          performance: 0.70,
          accessibility: 0.85,
          bestPractices: 0.85,
        },
      },
      "/dashboard": {
        name: "Dashboard Page",
        minScores: {
          performance: 0.75,
          accessibility: 0.90,
          bestPractices: 0.85,
        },
      },
    },
  };

  it("passes when all page scores meet or exceed budget", () => {
    const scores = {
      "/api/auth/signin": {
        performance: 0.85,
        accessibility: 0.95,
        bestPractices: 0.90,
      },
      "/dashboard": {
        performance: 0.80,
        accessibility: 0.92,
        bestPractices: 0.88,
      },
    };

    const summary = evaluateLighthouseScores(scores, mockBudget);
    expect(summary.passed).toBe(true);
    expect(summary.failedPages).toBe(0);
    expect(summary.passedPages).toBe(2);
  });

  it("fails when any score falls below the budget threshold", () => {
    const scores = {
      "/api/auth/signin": {
        performance: 0.65, // Below 0.70 threshold
        accessibility: 0.95,
        bestPractices: 0.90,
      },
      "/dashboard": {
        performance: 0.80,
        accessibility: 0.92,
        bestPractices: 0.88,
      },
    };

    const summary = evaluateLighthouseScores(scores, mockBudget);
    expect(summary.passed).toBe(false);
    expect(summary.failedPages).toBe(1);

    const signinResult = summary.results.find((r) => r.path === "/api/auth/signin");
    expect(signinResult?.passed).toBe(false);
    expect(signinResult?.failures[0]).toContain("Performance score 65 < budget 70");
  });

  it("formats Markdown summary table with emoji badges", () => {
    const scores = {
      "/api/auth/signin": {
        performance: 0.92,
        accessibility: 0.95,
        bestPractices: 0.90,
      },
    };

    const summary = evaluateLighthouseScores(scores, mockBudget);
    const md = formatLighthouseMarkdownSummary(summary);

    expect(md).toContain("## 📊 Lighthouse CI Performance & Accessibility Results");
    expect(md).toContain("| Page / Surface | Performance (Min) | Accessibility (Min) | Best Practices (Min) | Status |");
    expect(md).toContain("Sign-in Page");
    expect(md).toContain("🟢 92");
    expect(md).toContain("✅ PASS");
  });

  it("loads committed lighthouse-budget.json correctly", () => {
    const budget = loadLighthouseBudget();
    expect(budget.pages).toBeDefined();
    expect(budget.pages["/dashboard"]).toBeDefined();
    expect(budget.pages["/api/auth/signin"]).toBeDefined();
  });
});
