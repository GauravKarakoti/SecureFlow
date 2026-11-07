import { describe, expect, it } from "vitest";
import { MAX_SCANNED_BYTES } from "../scanner.js";
import { scanSuppliedContent } from "./scan.js";

describe("scanSuppliedContent argument validation", () => {
  it("rejects unknown arguments", () => {
    expect(() => scanSuppliedContent({ content: "const a = 1;", bogus: 1 })).toThrow(
      "Unknown scan-content argument",
    );
  });

  it("requires content to be a string", () => {
    expect(() => scanSuppliedContent({})).toThrow("content must be a string");
    expect(() => scanSuppliedContent({ content: 42 })).toThrow("content must be a string");
  });

  it("rejects content larger than MAX_SCANNED_BYTES", () => {
    const oversized = "a".repeat(MAX_SCANNED_BYTES + 1);
    expect(() => scanSuppliedContent({ content: oversized })).toThrow(
      `at most ${MAX_SCANNED_BYTES} UTF-8 bytes`,
    );
  });

  it("counts multibyte characters towards the byte limit", () => {
    const oversized = "🔥".repeat(MAX_SCANNED_BYTES / 4 + 1);
    expect(() => scanSuppliedContent({ content: oversized })).toThrow(
      `at most ${MAX_SCANNED_BYTES} UTF-8 bytes`,
    );
  });

  it("requires intentToken to be a string when present", () => {
    expect(() => scanSuppliedContent({ content: "const a = 1;", intentToken: 123 })).toThrow(
      "intentToken must be a string",
    );
  });

  it("defaults the report label to input.ts", () => {
    const out = scanSuppliedContent({ content: "const a = 1;" });
    expect(out.results[0]!.path).toBe("input.ts");
  });

  it("accepts a safe relative path label", () => {
    const out = scanSuppliedContent({ content: "const a = 1;", path: "src/deep/file.ts" });
    expect(out.results[0]!.path).toBe("src/deep/file.ts");
  });

  it.each([
    ["too long", `${"a".repeat(257)}.ts`],
    ["absolute", "/etc/passwd"],
    ["with parent segments", "src/../../secret.ts"],
    ["with dot segments", "src/./file.ts"],
    ["with empty segments", "src//file.ts"],
    ["with spaces", "my file.ts"],
    ["starting with a dot", ".env"],
  ])("rejects a path label that is %s", (_label, path) => {
    expect(() => scanSuppliedContent({ content: "const a = 1;", path })).toThrow(
      "path must be a relative report label",
    );
  });

  it.each([NaN, Infinity, -0.1, 8.1, "2.8"])("rejects minEntropy=%s", (minEntropy) => {
    expect(() => scanSuppliedContent({ content: "const a = 1;", minEntropy })).toThrow(
      "minEntropy must be a finite number between 0 and 8",
    );
  });

  it.each([7, 8.5, 257, "16"])("rejects minTokenLength=%s", (minTokenLength) => {
    expect(() => scanSuppliedContent({ content: "const a = 1;", minTokenLength })).toThrow(
      "minTokenLength must be an integer between 8 and 256",
    );
  });

  it("rejects an unsupported output format", () => {
    expect(() => scanSuppliedContent({ content: "const a = 1;", format: "xml" })).toThrow(
      "Unsupported scan output format",
    );
  });

  it("accepts every advertised format including the md alias", () => {
    for (const format of ["json", "text", "sarif", "csv", "html", "markdown", "md"]) {
      const out = scanSuppliedContent({ content: "const a = 1;", format });
      expect(typeof out.report).toBe("string");
    }
  });
});

describe("scanSuppliedContent scanning", () => {
  it("reports no violations for clean source", () => {
    const out = scanSuppliedContent({ content: "const answer = 42;\nconsole.log(answer);" });
    expect(out.violationCount).toBe(0);
    expect(out.source).toBe("caller_provided");
  });

  it("flags a high-entropy literal in a console call and redacts the source", () => {
    const token = "A8f3kL9Qw2xZ7pR4tY6uI1o0";
    const out = scanSuppliedContent({ content: `console.log("${token}");` });
    expect(out.violationCount).toBe(1);
    expect(out.results[0]!.violations[0]).toMatchObject({
      line: 1,
      severity: "HIGH",
      text: "[source redacted]",
    });
    expect(out.report).not.toContain(token);
  });

  it("honours a higher minEntropy threshold", () => {
    const token = "A8f3kL9Qw2xZ7pR4tY6uI1o0";
    const lenient = scanSuppliedContent({ content: `console.log("${token}");` });
    const strict = scanSuppliedContent({
      content: `console.log("${token}");`,
      minEntropy: 8,
    });
    expect(lenient.violationCount).toBe(1);
    expect(strict.violationCount).toBe(0);
  });
});
