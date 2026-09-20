import { describe, it, expect } from "vitest";
import {
  escapeCsv,
  escapeHtml,
  escapeMarkdownTable,
  formatCsv,
  formatHtml,
  formatMarkdown,
} from "./exporters.js";
import type { FileScanResult } from "./scanner.js";

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
