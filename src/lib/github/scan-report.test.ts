import { describe, expect, it, vi } from "vitest";
import {
  SECUREFLOW_COMMENT_MARKER,
  renderScanReportSummary,
  renderScanReportWithBaseOwners,
  toBlockquote,
  toCodeSpan,
} from "./scan-report";

describe("rendering a sticky report with base CODEOWNERS", () => {
  const base = { owner: "example", repo: "project", baseRef: "base-sha" };
  const findings = [
    {
      severity: "LOW",
      type: "Example",
      fileLocation: "src/config.ts",
      explanation: "Example explanation",
    },
    { severity: "LOW", type: "Example", fileLocation: "src/generated/item.ts" },
  ];
  const input = { findings, totalFindings: 4, inlineCount: 2, commitSha: "head-sha" };
  const inline = ["src/api.ts", "src/api.ts"];

  it("adds owners per finding and counts findings posted inline", async () => {
    const getContent = vi.fn().mockResolvedValue({
      data: "*.ts @example/platform ops@example.test\n/src/generated/",
    });
    const body = await renderScanReportWithBaseOwners(
      { rest: { repos: { getContent } } },
      base,
      input,
      inline,
    );
    expect(body).toContain(
      "**By owner:** `@example/platform` (3), `ops@example.test` (3), Unowned (1)",
    );
    expect(body).toContain("`src/api.ts` (2) — `@example/platform`, `ops@example.test`");
    expect(body).toContain("`src/config.ts`\n**Owners:** `@example/platform`, `ops@example.test`");
    expect(body).toContain("`src/generated/item.ts`\n**Owners:** Unowned");
    expect(getContent).toHaveBeenCalledWith(expect.objectContaining({ ref: "base-sha" }));
  });

  it("renders the same ownership for findings moved to the sticky fallback", async () => {
    const client = {
      rest: { repos: { getContent: vi.fn().mockResolvedValue({ data: "*.ts @platform" }) } },
    };
    const all = [
      ...findings,
      ...inline.map((fileLocation) => ({ severity: "LOW", type: "Example", fileLocation })),
    ];
    const body = await renderScanReportWithBaseOwners(
      client,
      base,
      { ...input, findings: all },
      [],
    );
    expect(body).toContain("**By owner:** `@platform` (4)");
    expect(body.match(/\*\*Owners:\*\* `@platform`/g)).toHaveLength(4);
    expect(body).not.toContain("Owners of findings posted inline");
  });

  it("preserves the report byte for byte when base ownership is absent", async () => {
    const getContent = vi.fn().mockRejectedValue({ status: 404 });
    expect(
      await renderScanReportWithBaseOwners(
        { rest: { repos: { getContent } } },
        base,
        input,
        inline,
      ),
    ).toBe(renderScanReportSummary(input));
    expect(getContent).toHaveBeenCalledTimes(3);
  });

  it("preserves the original report when the optional ownership would be too long", async () => {
    const data = "* " + Array.from({ length: 5000 }, (_, index) => "@owner-" + index).join(" ");
    const client = { rest: { repos: { getContent: vi.fn().mockResolvedValue({ data }) } } };
    expect(await renderScanReportWithBaseOwners(client, base, input, inline)).toBe(
      renderScanReportSummary(input),
    );
  });
});

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
  it("always includes the hidden marker at the top of the comment", () => {
    const body = renderScanReportSummary({
      findings: [finding()],
      totalFindings: 1,
      inlineCount: 0,
    });

    expect(body.startsWith(SECUREFLOW_COMMENT_MARKER)).toBe(true);
  });

  it("includes the scanned commit SHA when provided", () => {
    const body = renderScanReportSummary({
      findings: [finding()],
      totalFindings: 1,
      inlineCount: 0,
      commitSha: "abc1234567890abcdef",
    });

    expect(body).toContain(SECUREFLOW_COMMENT_MARKER);
    expect(body).toContain("Scanned commit: `abc1234567890abcdef`");
  });

  it("omits the scanned commit line when commitSha is not provided", () => {
    const body = renderScanReportSummary({
      findings: [finding()],
      totalFindings: 1,
      inlineCount: 0,
    });

    expect(body).not.toContain("Scanned commit:");
  });

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

  it("includes finding permalink link when finding id is provided", () => {
    const body = renderScanReportSummary({
      findings: [finding({ id: "finding-xyz" })],
      totalFindings: 1,
      inlineCount: 0,
    });

    expect(body).toContain("🔗 [View Finding Details](/dashboard/findings/finding-xyz)");
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

  it("reports previously dismissed findings count in the summary (#1528)", () => {
    const body = renderScanReportSummary({
      findings: [finding()],
      totalFindings: 1,
      inlineCount: 0,
      previouslyDismissedCount: 1,
    });
    expect(body).toContain("1 previously dismissed");
  });

  it("renders expired ignore rules notice in the summary report", () => {
    const body = renderScanReportSummary({
      findings: [finding()],
      totalFindings: 1,
      inlineCount: 0,
      expiredIgnoreRules: [
        {
          pattern: "tests/fixtures/**",
          expires: "2026-11-01",
          reason: "Temporary test mocks",
        },
        {
          pattern: "legacy/old-auth.ts",
          expires: "2026-10-15",
        },
      ],
    });

    expect(body).toContain("### ⚠️ Expired Ignore Rules (2)");
    expect(body).toContain(
      "- ⚠️ ignore rule `tests/fixtures/**` expired on 2026-11-01 — reason: Temporary test mocks",
    );
    expect(body).toContain("- ⚠️ ignore rule `legacy/old-auth.ts` expired on 2026-10-15");
  });

  it("renders applied policy scopes section in the summary report (#1868)", () => {
    const body = renderScanReportSummary({
      findings: [finding()],
      totalFindings: 1,
      inlineCount: 0,
      appliedPolicyScopes: [
        {
          paths: ["terraform/**", "*.tf"],
          enable: ["Terraform Security"],
          fileCount: 3,
        },
        {
          paths: ["tests/**"],
          disable: ["Production Secrets"],
          fileCount: 1,
        },
      ],
    });

    expect(body).toContain("### 📁 Policy Scopes Applied (2)");
    expect(body).toContain("`terraform/**`, `*.tf`: Enabled **Terraform Security** (3 files)");
    expect(body).toContain("`tests/**`: Disabled **Production Secrets** (1 file)");
  });

  it("renders installation-wide rule suppression count in summary report (#1891)", () => {
    const body = renderScanReportSummary({
      findings: [finding()],
      totalFindings: 1,
      inlineCount: 0,
      ruleSuppressedCount: 4,
    });

    expect(body).toContain(
      "🛡️ **4** finding(s) were suppressed by installation suppression rule(s).",
    );
  });
});
