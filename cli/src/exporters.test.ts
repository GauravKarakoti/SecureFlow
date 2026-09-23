import { describe, it, expect } from "vitest";
import {
  escapeCsv,
  escapeHtml,
  escapeMarkdownTable,
  formatCsv,
  formatHtml,
  formatMarkdown,
  toMarkdownCodeSpan,
} from "./exporters.js";
import {
  blockingAiFindings,
  filterBySeverity,
  parseSeverityFilter,
  shouldFailScan,
  type FileScanResult,
  type Severity,
} from "./scanner.js";

const sampleResults: FileScanResult[] = [
  {
    path: "src/config/db.ts",
    violations: [
      {
        line: 15,
        text: 'console.log("DB Password:", process.env.DB_PASSWORD);',
        reason: "environment variable",
      },
      {
        line: 28,
        text: 'console.warn("API Token:", apiKeyToken);',
        reason: "secret-named identifier",
      },
    ],
  },
  {
    path: "src/utils/logger.ts",
    violations: [
      {
        line: 42,
        text: 'console.error("Auth:", customAuthSecret);',
        reason: "secret-named identifier",
      },
    ],
  },
  {
    path: "src/components/clean.ts",
    violations: [],
  },
];

const emptyResults: FileScanResult[] = [{ path: "src/safe.ts", violations: [] }];

// ---------------------------------------------------------------------------
// escapeCsv
// ---------------------------------------------------------------------------

describe("escapeCsv", () => {
  it("should return plain values unchanged", () => {
    expect(escapeCsv("hello")).toBe("hello");
  });

  it("should wrap and double-quote values containing commas", () => {
    expect(escapeCsv("hello, world")).toBe('"hello, world"');
  });

  it("should wrap and double internal quotes", () => {
    expect(escapeCsv('hello "secret"')).toBe('"hello ""secret"""');
  });

  it("should handle values with both commas and quotes", () => {
    expect(escapeCsv('hello, "secret"')).toBe('"hello, ""secret"""');
  });

  it("should wrap values containing newlines", () => {
    expect(escapeCsv("line1\nline2")).toBe('"line1\nline2"');
  });

  it("should wrap values containing carriage returns", () => {
    expect(escapeCsv("line1\rline2")).toBe('"line1\rline2"');
  });

  it.each(["=", "+", "-", "@", "\t", "\r"])(
    "should neutralise a value starting with the formula trigger %j",
    (trigger) => {
      const escaped = escapeCsv(`${trigger}HYPERLINK("http://evil.test")`);
      // Quoted because the payload contains double quotes; the apostrophe sits inside.
      expect(escaped.startsWith(`"'${trigger}`)).toBe(true);
    },
  );

  it("should neutralise a formula without other special characters", () => {
    expect(escapeCsv("=1+1")).toBe("'=1+1");
  });

  it("should not alter a trigger character that is not at the start", () => {
    expect(escapeCsv("a=b")).toBe("a=b");
  });
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
  it("should escape ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("should escape angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("should escape double quotes", () => {
    expect(escapeHtml('key="value"')).toBe("key=&quot;value&quot;");
  });

  it("should escape single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("should escape a full XSS payload", () => {
    const input = '<script>alert("xss")</script>';
    const escaped = escapeHtml(input);
    expect(escaped).not.toContain("<script>");
    expect(escaped).toBe("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  });

  it("should return safe strings unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// formatCsv
// ---------------------------------------------------------------------------

describe("formatCsv", () => {
  it("should neutralise formula payloads in file paths and violation text", () => {
    const csv = formatCsv([
      {
        path: "=cmd|' /C calc'!A0.ts",
        violations: [{ line: 1, text: "@SUM(1+1)*cmd", reason: "environment variable" }],
      },
    ]);
    const row = csv.split("\n")[1];
    expect(row).toBe("'=cmd|' /C calc'!A0.ts,1,'@SUM(1+1)*cmd,environment variable");
  });

  it("should output correct CSV headers", () => {
    const csv = formatCsv(sampleResults);
    const firstLine = csv.split("\n")[0];
    expect(firstLine).toBe("File,Line,Violation,Reason");
  });

  it("should output correct rows for multiple violations", () => {
    const csv = formatCsv(sampleResults);
    const lines = csv.trimEnd().split("\n");
    // 1 header + 3 violations (clean file has 0)
    expect(lines).toHaveLength(4);
  });

  it("should include file path, line number, and reason in each row", () => {
    const csv = formatCsv(sampleResults);
    expect(csv).toContain("src/config/db.ts");
    expect(csv).toContain(",15,");
    expect(csv).toContain("environment variable");
    expect(csv).toContain("src/utils/logger.ts");
    expect(csv).toContain(",42,");
  });

  it("should produce headers only for empty results", () => {
    const csv = formatCsv(emptyResults);
    const lines = csv.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("File,Line,Violation,Reason");
  });

  it("should correctly escape commas in violation text", () => {
    const results: FileScanResult[] = [
      {
        path: "src/test.ts",
        violations: [{ line: 1, text: "console.log(a, b);", reason: "secret-named identifier" }],
      },
    ];
    const csv = formatCsv(results);
    // The violation text contains a comma, so it must be quoted
    expect(csv).toContain('"console.log(a, b);"');
  });

  it("should correctly escape double quotes in violation text", () => {
    const results: FileScanResult[] = [
      {
        path: "src/test.ts",
        violations: [
          { line: 5, text: 'console.log("secret");', reason: "secret-named identifier" },
        ],
      },
    ];
    const csv = formatCsv(results);
    // Internal quotes must be doubled and value wrapped
    expect(csv).toContain('"console.log(""secret"");"');
  });

  it("should correctly escape newlines in values", () => {
    const results: FileScanResult[] = [
      {
        path: "src/test.ts",
        violations: [{ line: 3, text: "line1\nline2", reason: "environment variable" }],
      },
    ];
    const csv = formatCsv(results);
    expect(csv).toContain('"line1\nline2"');
  });
});

// ---------------------------------------------------------------------------
// formatHtml
// ---------------------------------------------------------------------------

describe("formatHtml", () => {
  it("should output a valid HTML document structure", () => {
    const html = formatHtml(sampleResults);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("<head>");
    expect(html).toContain("<body>");
    expect(html).toContain("</html>");
  });

  it("should contain the report title", () => {
    const html = formatHtml(sampleResults);
    expect(html).toContain("<title>SecureFlow Scan Report</title>");
  });

  it("should contain file paths, line numbers, and reasons", () => {
    const html = formatHtml(sampleResults);
    expect(html).toContain("src/config/db.ts");
    expect(html).toContain("15");
    expect(html).toContain("environment variable");
    expect(html).toContain("src/utils/logger.ts");
    expect(html).toContain("42");
    expect(html).toContain("secret-named identifier");
  });

  it("should contain violation count in summary", () => {
    const html = formatHtml(sampleResults);
    expect(html).toContain("3 violations found.");
  });

  it("should show 'No violations detected' for empty results", () => {
    const html = formatHtml(emptyResults);
    expect(html).toContain("No violations detected.");
    expect(html).toContain("0 violations found.");
  });

  it("should HTML-escape source content to prevent XSS", () => {
    const xssResults: FileScanResult[] = [
      {
        path: "src/evil.ts",
        violations: [
          {
            line: 1,
            text: '<script>alert("xss")</script>',
            reason: "secret-named identifier",
          },
        ],
      },
    ];
    const html = formatHtml(xssResults);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  });

  it("should HTML-escape file paths", () => {
    const results: FileScanResult[] = [
      {
        path: "src/<inject>/config.ts",
        violations: [{ line: 1, text: "console.log(secret)", reason: "secret-named identifier" }],
      },
    ];
    const html = formatHtml(results);
    expect(html).toContain("src/&lt;inject&gt;/config.ts");
    expect(html).not.toContain("src/<inject>/config.ts");
  });

  it("should render multiple violations correctly", () => {
    const html = formatHtml(sampleResults);
    // Count the number of <tr> elements in tbody (excluding the header row)
    const dataRowMatches = html.match(/<tr>\s*\n\s*<td>/g);
    expect(dataRowMatches).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// escapeMarkdownTable
// ---------------------------------------------------------------------------

describe("escapeMarkdownTable", () => {
  it("should escape pipe characters", () => {
    expect(escapeMarkdownTable("foo|bar")).toBe("foo\\|bar");
  });

  it("should replace newlines with <br>", () => {
    expect(escapeMarkdownTable("line1\nline2")).toBe("line1<br>line2");
    expect(escapeMarkdownTable("line1\r\nline2")).toBe("line1<br>line2");
  });

  it("should escape backslashes", () => {
    expect(escapeMarkdownTable("C:\\path\\file.ts")).toBe("C:\\\\path\\\\file.ts");
  });

  it("should handle normal strings unchanged", () => {
    expect(escapeMarkdownTable("src/utils/logger.ts")).toBe("src/utils/logger.ts");
  });
});

// ---------------------------------------------------------------------------
// formatMarkdown
// ---------------------------------------------------------------------------

describe("formatMarkdown", () => {
  it("should render report title and table headers", () => {
    const md = formatMarkdown(sampleResults);
    expect(md).toContain("# 🛡️ SecureFlow Scan Report");
    expect(md).toContain("| File | Line | Violation | Reason |");
    expect(md).toContain("| --- | --- | --- | --- |");
  });

  it("should contain violation details in markdown table format", () => {
    const md = formatMarkdown(sampleResults);
    expect(md).toContain(
      '| src/config/db.ts | 15 | `console.log("DB Password:", process.env.DB_PASSWORD);` | environment variable |',
    );
    expect(md).toContain(
      '| src/utils/logger.ts | 42 | `console.error("Auth:", customAuthSecret);` | secret-named identifier |',
    );
  });

  it("should render total violation count summary", () => {
    const md = formatMarkdown(sampleResults);
    expect(md).toContain("Found **3** violations.");
  });

  it("should render clean state when no violations are found", () => {
    const md = formatMarkdown(emptyResults);
    expect(md).toContain("✅ **No violations detected.**");
    expect(md).not.toContain("| File | Line | Violation | Reason |");
  });

  it("should escape pipe characters inside violation code blocks", () => {
    const pipeResults: FileScanResult[] = [
      {
        path: "src/pipe.ts",
        violations: [
          {
            line: 10,
            text: 'console.log("a|b");',
            reason: "secret-named identifier",
          },
        ],
      },
    ];
    const md = formatMarkdown(pipeResults);
    expect(md).toContain('`console.log("a\\|b");`');
  });
});

describe("toMarkdownCodeSpan", () => {
  it("keeps a backtick inside the span instead of closing it early", () => {
    const source = "console.log(`token: ${t}`)";
    const span = toMarkdownCodeSpan(source);

    expect(span).toBe("``console.log(`token: ${t}`)``");
    const fence = span.slice(0, span.length - span.replace(/^`+/, "").length);
    expect(fence.length).toBeGreaterThan(
      Math.max(...[...source.matchAll(/`+/g)].map((r) => r[0].length)),
    );
  });

  it("lengthens the fence past the longest run, not just past one backtick", () => {
    const source = "a```b";
    expect(toMarkdownCodeSpan(source)).toBe("````a```b````");
  });

  it("pads a value that starts or ends with a backtick", () => {
    expect(toMarkdownCodeSpan("`x")).toBe("`` `x ``");
  });

  it("leaves backslashes alone, because a code span is literal", () => {
    expect(toMarkdownCodeSpan("C:\\temp")).toContain("C:\\temp");
    expect(toMarkdownCodeSpan("C:\\temp")).not.toContain("C:\\\\temp");
  });

  it("still escapes the pipe, which GFM resolves before code spans", () => {
    expect(toMarkdownCodeSpan("a | b")).toContain("\\|");
  });

  it("collapses newlines rather than emitting a <br> that would render literally", () => {
    const span = toMarkdownCodeSpan("first\nsecond");
    expect(span).not.toContain("<br>");
    expect(span).not.toContain("\n");
    expect(span).toContain("first second");
  });
});

describe("formatMarkdown code spans", () => {
  it("emits a row whose code span is closed by its own fence", () => {
    const results = [
      {
        path: "src/auth.ts",
        violations: [
          {
            line: 3,
            text: "console.log(`key: ${k}`)",
            reason: "logs a secret",
          },
        ],
      },
    ] as never;

    const row = formatMarkdown(results)
      .split("\n")
      .find((l) => l.includes("src/auth.ts"));

    expect(row).toBeDefined();
    expect(row).toContain("``console.log(`key: ${k}`)``");
  });
});

// ---------------------------------------------------------------------------
// parseSeverityFilter
// ---------------------------------------------------------------------------

describe("parseSeverityFilter", () => {
  it("should parse a single severity level", () => {
    const result = parseSeverityFilter("high");
    expect(result).toEqual(new Set(["HIGH"]));
  });

  it("should parse multiple comma-separated severity levels", () => {
    const result = parseSeverityFilter("high,critical");
    expect(result).toEqual(new Set(["HIGH", "CRITICAL"]));
  });

  it("should be case-insensitive", () => {
    expect(parseSeverityFilter("High")).toEqual(new Set(["HIGH"]));
    expect(parseSeverityFilter("CRITICAL,low")).toEqual(new Set(["CRITICAL", "LOW"]));
    expect(parseSeverityFilter("Medium")).toEqual(new Set(["MEDIUM"]));
  });

  it("should throw on invalid severity levels", () => {
    expect(() => parseSeverityFilter("invalid")).toThrow("Invalid severity level(s): INVALID");
  });

  it("should throw listing all invalid levels when multiple are bad", () => {
    expect(() => parseSeverityFilter("high,bogus,fake")).toThrow("BOGUS, FAKE");
  });

  it("should handle whitespace around values", () => {
    const result = parseSeverityFilter(" high , critical ");
    expect(result).toEqual(new Set(["HIGH", "CRITICAL"]));
  });
});

// ---------------------------------------------------------------------------
// filterBySeverity
// ---------------------------------------------------------------------------

describe("filterBySeverity", () => {
  const labeledResults: FileScanResult[] = [
    {
      path: "src/a.ts",
      violations: [
        {
          line: 1,
          text: "console.log(process.env.X)",
          reason: "environment variable",
          severity: "CRITICAL",
        },
        {
          line: 5,
          text: "console.log(token)",
          reason: "secret-named identifier",
          severity: "HIGH",
        },
      ],
    },
  ];

  it("should pass through violations without severity regardless of filter", () => {
    const filtered = filterBySeverity(sampleResults, new Set(["CRITICAL" as Severity]));
    const allViolations = filtered.flatMap((f) => f.violations);
    expect(allViolations).toHaveLength(3);
  });

  it("should filter labeled violations to a single severity", () => {
    const filtered = filterBySeverity(labeledResults, new Set(["CRITICAL" as Severity]));
    const allViolations = filtered.flatMap((f) => f.violations);
    expect(allViolations).toHaveLength(1);
    expect(allViolations[0]!.severity).toBe("CRITICAL");
  });

  it("should filter labeled violations to multiple severities", () => {
    const filtered = filterBySeverity(
      labeledResults,
      new Set(["HIGH" as Severity, "CRITICAL" as Severity]),
    );
    const allViolations = filtered.flatMap((f) => f.violations);
    expect(allViolations).toHaveLength(2);
  });

  it("should exclude labeled violations that do not match the filter", () => {
    const filtered = filterBySeverity(labeledResults, new Set(["LOW" as Severity]));
    const allViolations = filtered.flatMap((f) => f.violations);
    expect(allViolations).toHaveLength(0);
  });

  it("should handle a mix of labeled and unlabeled violations", () => {
    const mixed: FileScanResult[] = [
      {
        path: "src/mix.ts",
        violations: [
          { line: 1, text: "console.log(secret)", reason: "secret-named identifier" },
          {
            line: 2,
            text: "console.log(token)",
            reason: "secret-named identifier",
            severity: "HIGH",
          },
          {
            line: 3,
            text: "console.log(process.env.X)",
            reason: "environment variable",
            severity: "CRITICAL",
          },
        ],
      },
    ];
    const filtered = filterBySeverity(mixed, new Set(["CRITICAL" as Severity]));
    const allViolations = filtered.flatMap((f) => f.violations);
    // unlabeled (line 1) passes through + CRITICAL (line 3) matches
    expect(allViolations).toHaveLength(2);
    expect(allViolations.map((v) => v.line)).toEqual([1, 3]);
  });

  it("should preserve file entries even when all labeled violations are filtered out", () => {
    const filtered = filterBySeverity(labeledResults, new Set(["LOW" as Severity]));
    expect(filtered).toHaveLength(labeledResults.length);
  });
});

// ---------------------------------------------------------------------------
// AI finding severity filtering (mirrors index.ts wiring)
// ---------------------------------------------------------------------------

describe("AI finding severity filtering", () => {
  const aiFindings = [
    {
      type: "secret-exposure",
      severity: "CRITICAL" as const,
      description: "API key in log",
      fileLocation: "src/a.ts",
      lineStart: 1,
    },
    {
      type: "secret-exposure",
      severity: "HIGH" as const,
      description: "Token in log",
      fileLocation: "src/b.ts",
      lineStart: 5,
    },
    {
      type: "info-leak",
      severity: "MEDIUM" as const,
      description: "Debug info",
      fileLocation: "src/c.ts",
      lineStart: 10,
    },
    {
      type: "info-leak",
      severity: "LOW" as const,
      description: "Verbose log",
      fileLocation: "src/d.ts",
      lineStart: 20,
    },
  ];

  it("--severity=critical should keep only CRITICAL AI findings", () => {
    const filter = parseSeverityFilter("critical");
    const filtered = aiFindings.filter((f) => filter.has(f.severity));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.severity).toBe("CRITICAL");
  });

  it("--severity=high,critical should keep HIGH and CRITICAL AI findings", () => {
    const filter = parseSeverityFilter("high,critical");
    const filtered = aiFindings.filter((f) => filter.has(f.severity));
    expect(filtered).toHaveLength(2);
    expect(filtered.map((f) => f.severity)).toEqual(["CRITICAL", "HIGH"]);
  });

  it("--severity filters display but does not affect exit-code input", () => {
    const filter = parseSeverityFilter("low");
    const displayed = aiFindings.filter((f) => filter.has(f.severity));
    expect(displayed).toHaveLength(1);
    expect(displayed[0]!.severity).toBe("LOW");

    // Exit-code logic uses unfiltered findings — shouldFailScan sees all 4
    expect(shouldFailScan(0, aiFindings, null)).toBe(true);
  });

  it("no filter should preserve all AI findings", () => {
    expect(aiFindings).toHaveLength(4);
    expect(shouldFailScan(0, aiFindings, null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --severity + --fail-on combined interaction
// ---------------------------------------------------------------------------

describe("--severity and --fail-on combined", () => {
  const aiFindings: {
    severity: Severity;
    type: string;
    description: string;
    fileLocation: string;
    lineStart: number;
  }[] = [
    { severity: "CRITICAL", type: "a", description: "a", fileLocation: "a.ts", lineStart: 1 },
    { severity: "HIGH", type: "b", description: "b", fileLocation: "b.ts", lineStart: 2 },
    { severity: "MEDIUM", type: "c", description: "c", fileLocation: "c.ts", lineStart: 3 },
    { severity: "LOW", type: "d", description: "d", fileLocation: "d.ts", lineStart: 4 },
  ];

  it("--severity=critical does NOT hide HIGH findings from --fail-on=high", () => {
    // --severity=critical means the user only SEES critical in output
    const severityFilter = parseSeverityFilter("critical");
    const displayed = aiFindings.filter((f) => severityFilter.has(f.severity));
    expect(displayed).toHaveLength(1);

    // But --fail-on=high must still see ALL findings, including the HIGH one
    // that was filtered from display. Otherwise CI silently passes.
    expect(shouldFailScan(0, aiFindings, "HIGH")).toBe(true);
    expect(blockingAiFindings(aiFindings, "HIGH")).toHaveLength(2);
  });

  it("--severity=low --fail-on=high still blocks on the unseen HIGH finding", () => {
    const severityFilter = parseSeverityFilter("low");
    const displayed = aiFindings.filter((f) => severityFilter.has(f.severity));
    expect(displayed).toHaveLength(1);
    expect(displayed[0]!.severity).toBe("LOW");

    // The HIGH and CRITICAL findings are hidden from output but still block
    expect(shouldFailScan(0, aiFindings, "HIGH")).toBe(true);
  });

  it("--fail-on=NONE makes scan advisory regardless of --severity filter", () => {
    expect(shouldFailScan(0, aiFindings, "NONE")).toBe(false);
    expect(blockingAiFindings(aiFindings, "NONE")).toHaveLength(0);
  });

  it("--severity=critical --fail-on=critical blocks on the CRITICAL finding", () => {
    const severityFilter = parseSeverityFilter("critical");
    const displayed = aiFindings.filter((f) => severityFilter.has(f.severity));
    expect(displayed).toHaveLength(1);

    expect(shouldFailScan(0, aiFindings, "CRITICAL")).toBe(true);
    expect(blockingAiFindings(aiFindings, "CRITICAL")).toHaveLength(1);
  });
});
