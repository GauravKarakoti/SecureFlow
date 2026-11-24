import { describe, it, expect } from "vitest";
import {
  parseUnifiedPatch,
  renderNumberedLines,
  renderDiffWithContext,
  renderNumberedLinesWithContext,
  changedLineNumbers,
  estimateDiffTokens,
  DEFAULT_CONTEXT_LINES,
  MAX_CONTEXT_LINES,
  MIN_CONTEXT_LINES,
} from "./diff";

const patch = (...lines: string[]) => lines.join("\n");

describe("diff context rendering (#2006)", () => {
  const samplePatch = patch(
    "@@ -10,12 +10,12 @@",
    " const a = 1;",
    " const b = 2;",
    " const c = 3;",
    " const d = 4;",
    " const e = 5;",
    "-const oldKey = 'insecure';",
    "+const newKey = 'safe-token';",
    " const f = 6;",
    " const g = 7;",
    " const h = 8;",
    " const i = 9;",
    " const j = 10;",
  );

  it("extracts only added lines when contextLines is 0", () => {
    const rendered = renderDiffWithContext(samplePatch, { contextLines: 0 });
    expect(rendered).toBe("15: [CHANGED] const newKey = 'safe-token';");
  });

  it("includes up to contextLines (default 5) unchanged lines around the changed hunk", () => {
    const rendered = renderDiffWithContext(samplePatch, { contextLines: 3 });
    const lines = rendered.split("\n");

    expect(lines).toEqual([
      "12: [UNCHANGED CONTEXT] const c = 3;",
      "13: [UNCHANGED CONTEXT] const d = 4;",
      "14: [UNCHANGED CONTEXT] const e = 5;",
      "15: [CHANGED] const newKey = 'safe-token';",
      "16: [UNCHANGED CONTEXT] const f = 6;",
      "17: [UNCHANGED CONTEXT] const g = 7;",
      "18: [UNCHANGED CONTEXT] const h = 8;",
    ]);
  });

  it("caps contextLines at MAX_CONTEXT_LINES (20)", () => {
    const rendered = renderDiffWithContext(samplePatch, { contextLines: 50 });
    // In samplePatch there are only 5 context lines before and 5 after, so all available are included
    expect(rendered).toContain("10: [UNCHANGED CONTEXT] const a = 1;");
    expect(rendered).toContain("20: [UNCHANGED CONTEXT] const j = 10;");
  });

  it("renders with plain numbering when markContext is false", () => {
    const rendered = renderDiffWithContext(samplePatch, { contextLines: 1, markContext: false });
    expect(rendered).toBe(
      ["14: const e = 5;", "15: const newKey = 'safe-token';", "16: const f = 6;"].join("\n"),
    );
  });

  it("fetches context lines from fullContent when provided", () => {
    const fullFile = [
      "import { sanitize } from './security';",
      "const config = load();",
      "function run() {",
      "  const pre1 = 1;",
      "  const pre2 = 2;",
      "  const pre3 = 3;",
      "  const pre4 = 4;",
      "  const pre5 = 5;",
      "  const safe = sanitize(input);",
      "  process(safe);",
      "  const post1 = 1;",
      "  const post2 = 2;",
      "  const post3 = 3;",
      "}",
    ].join("\n");

    // Patch modifying line 10 ("  process(safe);")
    const testPatch = patch("@@ -10,1 +10,1 @@", "-  process(input);", "+  process(safe);");

    const rendered = renderDiffWithContext(testPatch, {
      contextLines: 3,
      fullContent: fullFile,
      markContext: true,
    });

    const lines = rendered.split("\n");
    expect(lines).toEqual([
      "7: [UNCHANGED CONTEXT]   const pre4 = 4;",
      "8: [UNCHANGED CONTEXT]   const pre5 = 5;",
      "9: [UNCHANGED CONTEXT]   const safe = sanitize(input);",
      "10: [CHANGED]   process(safe);",
      "11: [UNCHANGED CONTEXT]   const post1 = 1;",
      "12: [UNCHANGED CONTEXT]   const post2 = 2;",
      "13: [UNCHANGED CONTEXT]   const post3 = 3;",
    ]);
  });

  it("changedLineNumbers returns only lines that were added/changed", () => {
    const parsed = parseUnifiedPatch(samplePatch);
    const changed = changedLineNumbers(parsed);

    expect(changed.size).toBe(1);
    expect(changed.has(15)).toBe(true);
    expect(changed.has(14)).toBe(false);
    expect(changed.has(16)).toBe(false);
  });

  it("prompt size growth is bounded by MAX_CONTEXT_LINES", () => {
    // Large file with 100 lines
    const bigFile = Array.from({ length: 100 }, (_, i) => `line_${i + 1} = ${i + 1};`).join("\n");
    const testPatch = patch("@@ -50,1 +50,1 @@", "-line_50 = 0;", "+line_50 = 999;");

    const sizeContext0 = renderDiffWithContext(testPatch, {
      contextLines: 0,
      fullContent: bigFile,
    }).length;
    const sizeContext5 = renderDiffWithContext(testPatch, {
      contextLines: 5,
      fullContent: bigFile,
    }).length;
    const sizeContext20 = renderDiffWithContext(testPatch, {
      contextLines: 20,
      fullContent: bigFile,
    }).length;
    const sizeContext100 = renderDiffWithContext(testPatch, {
      contextLines: 100,
      fullContent: bigFile,
    }).length;

    expect(sizeContext0).toBeLessThan(sizeContext5);
    expect(sizeContext5).toBeLessThan(sizeContext20);
    // Because it is capped at 20, contextLines 100 produces the exact same bounded size as contextLines 20!
    expect(sizeContext100).toBe(sizeContext20);
  });

  it("estimateDiffTokens estimates token count based on rendered context", () => {
    const tokens0 = estimateDiffTokens(samplePatch, { contextLines: 0 });
    const tokens5 = estimateDiffTokens(samplePatch, { contextLines: 5 });

    expect(tokens0).toBeGreaterThan(0);
    expect(tokens5).toBeGreaterThan(tokens0);
    expect(estimateDiffTokens("")).toBe(0);
  });
});
