import { describe, expect, it } from "vitest";
import { renderScanReportSummary, toBlockquote, toCodeSpan } from "./scan-report";

const finding = (overrides: Record<string, unknown> = {}) => ({
  severity: "HIGH",
  type: "SECRET",
  fileLocation: "src/config.ts",
  explanation: "Hardcoded key.",
  remediation: "Move it to an environment variable.",
  promptInjectionSuspected: false,
  ...overrides,
});

describe("toBlockquote", () => {
  it("quotes every line, including blank ones, so paragraphs stay inside the quote", () => {
    expect(toBlockquote("First paragraph.\n\nSecond paragraph.\nSame paragraph.")).toBe(
      "> First paragraph.\n>\n> Second paragraph.\n> Same paragraph.",
    );
  });

  it("normalises CRLF and trims surrounding blank lines", () => {
    expect(toBlockquote("\r\nOne.\r\n\r\nTwo.\r\n")).toBe("> One.\n>\n> Two.");
  });
});

describe("toCodeSpan", () => {
  it("uses a single backtick fence for ordinary paths", () => {
    expect(toCodeSpan("src/app.ts")).toBe("`src/app.ts`");
  });

  it("uses a longer fence than any backtick run in the value", () => {
    expect(toCodeSpan("src/a`b.ts")).toBe("``src/a`b.ts``");
    expect(toCodeSpan("x``y")).toBe("```x``y```");
  });

  it("pads a value that starts or ends with a backtick", () => {
    expect(toCodeSpan("`weird")).toBe("`` `weird ``");
  });
});

describe("renderScanReportSummary", () => {
  it("keeps a multi-paragraph explanation inside its blockquote", () => {
    const body = renderScanReportSummary({
      findings: [finding({ explanation: "Line one.\n\nThis paragraph used to escape the quote." })],
      totalFindings: 1,
      inlineCount: 0,
    });

    expect(body).toContain("> Line one.\n>\n> This paragraph used to escape the quote.\n");
    expect(body).not.toMatch(/^This paragraph/m);
  });

  it("renders the heading, the file as a safe code span, and the remediation", () => {
    const body = renderScanReportSummary({
      findings: [finding({ fileLocation: "src/we`ird.ts" })],
      totalFindings: 1,
      inlineCount: 0,
    });

    expect(body).toContain("### 🛡️ SecureFlow AI Security Report");
    expect(body).toContain("Detected **1** potential issues");
    expect(body).toContain("**SECRET** in ``src/we`ird.ts``");
    expect(body).toContain("Move it to an environment variable.");
  });

  it("mentions inline annotations only when some findings were posted inline", () => {
    const withInline = renderScanReportSummary({
      findings: [finding()],
      totalFindings: 3,
      inlineCount: 2,
    });
    expect(withInline).toContain("📍 **2** finding(s) are annotated inline");

    const allInSummary = renderScanReportSummary({
      findings: [finding(), finding(), finding()],
      totalFindings: 3,
      inlineCount: 2,
    });
    expect(allInSummary).not.toContain("annotated inline");
  });

  it("includes the coverage notice and the injection warning when present", () => {
    const body = renderScanReportSummary({
      findings: [finding({ promptInjectionSuspected: true })],
      totalFindings: 1,
      inlineCount: 0,
      coverageNotice: "Only 300 of 400 files were analysed.",
    });

    expect(body).toContain("Only 300 of 400 files were analysed.");
    expect(body).toContain("AI explanation may be unreliable");
  });

  it("does not print 'undefined' for a finding with no explanation or remediation", () => {
    const body = renderScanReportSummary({
      findings: [finding({ explanation: null, remediation: undefined })],
      totalFindings: 1,
      inlineCount: 0,
    });
    expect(body).not.toContain("undefined");
    expect(body).not.toContain("null");
  });
});
