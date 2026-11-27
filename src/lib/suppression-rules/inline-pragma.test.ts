import { describe, expect, it } from "vitest";
import { evaluateInlinePragmaSuppressions, parseInlinePragmas } from "./inline-pragma";
import { evaluateAllSuppressions } from "./matcher";

describe("Inline Pragma Suppression Parser & Evaluator", () => {
  it("parses inline, next-line, and block comment pragmas across languages", () => {
    const source = [
      "const token = 'demo'; // secureflow-ignore[SECRET] reason=\"Unit test fixture\"",
      '# secureflow-ignore-next-line[CWE-89, SQL_INJECTION] reason="Safe query" expires=2027-06-01',
      "db.execute(query);",
      '/* secureflow-ignore[XSS] reason="Escaped by template" */',
    ].join("\n");

    const pragmas = parseInlinePragmas(source, { now: new Date("2026-11-27T00:00:00Z") });
    expect(pragmas).toHaveLength(3);

    expect(pragmas[0]).toMatchObject({
      commentLine: 1,
      targetLine: 1,
      isNextLine: false,
      ruleIds: ["SECRET"],
      reason: "Unit test fixture",
      active: true,
    });

    expect(pragmas[1]).toMatchObject({
      commentLine: 2,
      targetLine: 3,
      isNextLine: true,
      ruleIds: ["CWE-89", "SQL_INJECTION"],
      expiresAt: "2027-06-01",
      expired: false,
      active: true,
    });

    expect(pragmas[2]).toMatchObject({
      commentLine: 4,
      targetLine: 4,
      ruleIds: ["XSS"],
      reason: "Escaped by template",
      active: true,
    });
  });

  it("flags expired pragmas and enforces strictReason mode", () => {
    const source = [
      'const a = 1; // secureflow-ignore[XSS] expires=2026-01-01 reason="Old waiver"',
      "const b = 2; // secureflow-ignore[XSS]",
    ].join("\n");

    const pragmas = parseInlinePragmas(source, {
      now: new Date("2026-11-27T00:00:00Z"),
      strictReason: true,
    });

    expect(pragmas[0].expired).toBe(true);
    expect(pragmas[0].active).toBe(false);
    expect(pragmas[0].inactiveReason).toBe("expired");

    expect(pragmas[1].active).toBe(false);
    expect(pragmas[1].inactiveReason).toBe("missing_reason");
  });

  it("suppresses matching findings by file, line, and rule ID and records audit trail", () => {
    const sourceByFile = {
      "src/app.ts": [
        '// secureflow-ignore-next-line[CWE-79] reason="DOMPurify applied"',
        "el.innerHTML = cleanHtml;",
        "const secret = 'abc'; // secureflow-ignore[SECRET] reason=\"Mock key\"",
      ].join("\n"),
    };

    const findings = [
      { type: "XSS", cwe: "CWE-79", fileLocation: "src/app.ts", lineStart: 2 },
      { type: "SQL_INJECTION", cwe: "CWE-89", fileLocation: "src/app.ts", lineStart: 2 },
      { type: "SECRET", fileLocation: "src/app.ts", lineStart: 3 },
    ];

    const result = evaluateInlinePragmaSuppressions(findings, sourceByFile);
    expect(result.suppressedFindings).toHaveLength(2);
    expect(result.activeFindings).toHaveLength(1);
    expect(result.activeFindings[0].type).toBe("SQL_INJECTION");
    expect(result.suppressedFindings[0].suppressionStatus).toBe("SUPPRESSED_BY_PRAGMA");
    expect(result.auditRecords).toHaveLength(2);
  });

  it("combines inline pragmas and installation suppression rules in evaluateAllSuppressions", () => {
    const sourceByFile = {
      "src/a.ts": 'const x = 1; // secureflow-ignore[XSS] reason="Escaped"',
    };
    const findings = [
      { type: "XSS", fileLocation: "src/a.ts", lineStart: 1 },
      { type: "SECRET", fileLocation: "tests/fixture.ts", lineStart: 5 },
    ];
    const rules = [
      {
        id: "rule-tests",
        name: "Ignore test secrets",
        scope: "ALL",
        repositoryIds: [],
        matchCategory: "SECRET",
        pathGlob: "tests/**",
        reason: "Test fixtures",
      },
    ];

    const combined = evaluateAllSuppressions(findings, rules, sourceByFile);
    expect(combined.activeFindings).toHaveLength(0);
    expect(combined.suppressedFindings).toHaveLength(2);
    expect(combined.pragmaResult.suppressedFindings).toHaveLength(1);
    expect(combined.ruleResult.suppressedFindings).toHaveLength(1);
  });
});
