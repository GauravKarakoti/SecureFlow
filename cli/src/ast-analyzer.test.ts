import { describe, it, expect } from "vitest";
import {
  shouldRunAstAnalysis,
  scanFileWithAst,
} from "./ast-analyzer.js";
import { scanFile } from "./scanner.js";

describe("AST Semantic Taint Analysis Engine (#2062)", () => {
  it("identifies supported file extensions for AST analysis", () => {
    expect(shouldRunAstAnalysis("src/index.ts")).toBe(true);
    expect(shouldRunAstAnalysis("components/App.tsx")).toBe(true);
    expect(shouldRunAstAnalysis("lib/utils.js")).toBe(true);
    expect(shouldRunAstAnalysis("lib/utils.mjs")).toBe(true);
    expect(shouldRunAstAnalysis("config.json")).toBe(false);
    expect(shouldRunAstAnalysis("README.md")).toBe(false);
  });

  it("traces multi-statement taint propagation into console sink (SECUREFLOW-011)", () => {
    const code = `
      function authenticate() {
        const secretKey = process.env.AUTH_SECRET;
        const authHeader = \`Bearer \${secretKey}\`;
        console.log("Header configured: " + authHeader);
      }
    `;

    const violations = scanFileWithAst("src/auth.ts", code);
    expect(violations.length).toBeGreaterThan(0);

    const v = violations[0]!;
    expect(v.ruleId).toBe("SECUREFLOW-011");
    expect(v.severity).toBe("HIGH");
    expect(v.reason).toContain("environment variable");
    expect(v.line).toBe(5);
  });

  it("detects dynamic SQL query construction with unescaped taint (SECUREFLOW-010)", () => {
    const code = `
      async function findUser(req, db) {
        const userId = req.body.userId;
        const query = "SELECT * FROM users WHERE id = '" + userId + "'";
        return await db.query(query);
      }
    `;

    const violations = scanFileWithAst("src/db.ts", code);
    expect(violations.length).toBeGreaterThan(0);

    const v = violations[0]!;
    expect(v.ruleId).toBe("SECUREFLOW-010");
    expect(v.severity).toBe("CRITICAL");
    expect(v.reason).toContain("dynamic database query sink");
    expect(v.line).toBe(5);
  });

  it("detects shell command injection taint (SECUREFLOW-012)", () => {
    const code = `
      import cp from "child_process";
      function runScript(req) {
        const cmd = req.query.cmd;
        cp.exec(cmd);
      }
    `;

    const violations = scanFileWithAst("src/exec.ts", code);
    expect(violations.length).toBeGreaterThan(0);

    const v = violations[0]!;
    expect(v.ruleId).toBe("SECUREFLOW-012");
    expect(v.severity).toBe("CRITICAL");
    expect(v.line).toBe(5);
  });

  it("clears taint and suppresses violations when sanitized via maskSecret or encodeURIComponent", () => {
    const code = `
      function logMasked() {
        const token = process.env.API_KEY;
        const masked = maskSecret(token);
        console.log("Safe token is: " + masked);
      }
    `;

    const violations = scanFileWithAst("src/safe.ts", code);
    expect(violations).toHaveLength(0);
  });

  it("does not report violations on static clean database queries", () => {
    const code = `
      async function getMetrics(db) {
        return await db.query("SELECT COUNT(*) FROM logs");
      }
    `;

    const violations = scanFileWithAst("src/queries.ts", code);
    expect(violations).toHaveLength(0);
  });

  it("integrates seamlessly into scanFile pipeline", () => {
    const code = `
      const apiKey = process.env.STRIPE_SECRET_KEY;
      const debugMsg = \`Using key: \${apiKey}\`;
      console.info(debugMsg);
    `;

    const result = scanFile("src/billing.ts", code);
    expect(result.violations.length).toBeGreaterThan(0);

    const v = result.violations.find((x) => x.ruleId === "SECUREFLOW-011");
    expect(v).toBeDefined();
    expect(v?.severity).toBe("HIGH");
  });

  it("respects inline suppressions on AST-flagged taint findings", () => {
    const code = `
      const apiKey = process.env.STRIPE_SECRET_KEY;
      const debugMsg = \`Using key: \${apiKey}\`;
      // secureflow-ignore: Intentional development logger
      console.info(debugMsg);
    `;

    const result = scanFile("src/billing.ts", code);
    expect(result.violations).toHaveLength(0);
    expect(result.suppressedViolations).toBeDefined();
    expect(result.suppressedViolations).toHaveLength(1);
    expect(result.suppressedViolations?.[0]?.ruleId).toBe("SECUREFLOW-011");
  });
});
