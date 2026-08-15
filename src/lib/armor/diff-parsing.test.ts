/**
 * Regression tests for diff parsing and entity decoding (#529).
 *
 * `extractAddedLines` checked `line.startsWith('+++')` against every diff line,
 * before the leading `+` marker was stripped. An added source line beginning
 * with `++` therefore arrived as `+++…` and was mistaken for a `+++ b/file`
 * header: dropped from the scan, and — because the line counter was skipped
 * with it — shifting every following line number in that hunk by one.
 */
import { describe, it, expect } from "vitest";
import { extractAddedLines, sanitizeRecursively } from "./scanner";

const patch = (...lines: string[]) => lines.join("\n");

describe("extractAddedLines — ++ prefixed content", () => {
  it("keeps an added line starting with ++ and does not shift the numbering", () => {
    const result = extractAddedLines(
      patch("@@ -1,3 +1,5 @@", " let i = 0;", "+++i;", '+const KEY = "ghp_secret";', " return i;"),
    );

    expect(result).toBe(
      ["1: let i = 0;", "2: ++i;", '3: const KEY = "ghp_secret";', "4: return i;"].join("\n"),
    );
  });

  it("attributes a finding on the line after ++ content to the right number", () => {
    const result = extractAddedLines(
      patch("@@ -1,1 +1,2 @@", "+++counter;", '+const t = "secret";'),
    );

    expect(result).toContain('2: const t = "secret";');
  });

  it("handles a line of only plus signs", () => {
    const result = extractAddedLines(patch("@@ -1,1 +1,1 @@", "++++"));

    expect(result).toBe("1: +++");
  });

  it("keeps an added line starting with -- (a decrement)", () => {
    const result = extractAddedLines(patch("@@ -1,1 +1,2 @@", "+--i;", " done();"));

    expect(result).toBe(["1: --i;", "2: done();"].join("\n"));
  });
});

describe("extractAddedLines — headers and metadata", () => {
  it("still strips genuine file headers", () => {
    const result = extractAddedLines(
      patch("--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1,1 +1,1 @@", "+const x = 1;"),
    );

    expect(result).toBe("1: const x = 1;");
    expect(result).not.toContain("a/src/app.ts");
    expect(result).not.toContain("b/src/app.ts");
  });

  it("strips git metadata lines that precede the first hunk", () => {
    const result = extractAddedLines(
      patch(
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1234567..89abcde 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,1 +1,1 @@",
        "+const x = 1;",
      ),
    );

    expect(result).toBe("1: const x = 1;");
  });

  it("does not treat a --- line inside a hunk as a header", () => {
    const result = extractAddedLines(patch("@@ -1,1 +1,2 @@", "+--- not a header", " next();"));

    expect(result).toBe(["1: --- not a header", "2: next();"].join("\n"));
  });
});

describe("extractAddedLines — line numbering", () => {
  it("does not advance the counter for deleted lines", () => {
    const result = extractAddedLines(
      patch("@@ -1,3 +1,2 @@", " keep();", "-removed();", "+added();"),
    );

    expect(result).toBe(["1: keep();", "2: added();"].join("\n"));
  });

  it("omits deleted lines from the scanned text", () => {
    const result = extractAddedLines(
      patch("@@ -1,2 +1,1 @@", '-const OLD = "ghp_removed";', "+const NEW = 1;"),
    );

    expect(result).not.toContain("ghp_removed");
  });

  it("restarts numbering at each hunk header", () => {
    const result = extractAddedLines(
      patch("@@ -1,1 +1,1 @@", "+first();", "@@ -50,1 +60,1 @@", "+second();"),
    );

    expect(result).toBe(["1: first();", "60: second();"].join("\n"));
  });

  it("keeps an empty context line in the numbering", () => {
    const result = extractAddedLines(patch("@@ -1,3 +1,3 @@", " a();", "", " b();"));

    expect(result).toBe(["1: a();", "2: ", "3: b();"].join("\n"));
  });

  it("ignores the no-newline marker", () => {
    const result = extractAddedLines(
      patch("@@ -1,1 +1,1 @@", "+const x = 1;", "\\ No newline at end of file"),
    );

    expect(result).toBe("1: const x = 1;");
  });

  it("does not emit a trailing blank entry for a patch ending in a newline", () => {
    const result = extractAddedLines("@@ -1,1 +1,1 @@\n+const x = 1;\n");

    expect(result).toBe("1: const x = 1;");
  });

  it("returns an empty string for an empty patch", () => {
    expect(extractAddedLines("")).toBe("");
  });

  it("handles a hunk header without line counts", () => {
    const result = extractAddedLines(patch("@@ -1 +7 @@", "+seven();"));

    expect(result).toBe("7: seven();");
  });
});

describe("sanitizeRecursively — numeric character references", () => {
  it("decodes an astral code point correctly", () => {
    // U+1F600 needs fromCodePoint; fromCharCode truncated it to U+F600.
    expect(sanitizeRecursively("&#x1F600;")).toBe("\u{1F600}");
  });

  it("accepts uppercase hex references", () => {
    expect(sanitizeRecursively("&#X41;")).toBe("A");
  });

  it("accepts lowercase hex references", () => {
    expect(sanitizeRecursively("&#x41;")).toBe("A");
  });

  it("accepts decimal references", () => {
    expect(sanitizeRecursively("&#65;")).toBe("A");
  });

  it("leaves a malformed hex reference untouched instead of emitting NUL", () => {
    const result = sanitizeRecursively("&#xZZ;");

    expect(result).toBe("&#xZZ;");
    expect(result).not.toContain("\u0000");
  });

  it("leaves a malformed decimal reference untouched", () => {
    expect(sanitizeRecursively("&#12a;")).toBe("&#12a;");
  });

  it("leaves an out-of-range reference untouched rather than throwing", () => {
    expect(() => sanitizeRecursively("&#x110000;")).not.toThrow();
    expect(sanitizeRecursively("&#x110000;")).toBe("&#x110000;");
  });

  it("leaves a lone surrogate untouched", () => {
    expect(sanitizeRecursively("&#xD800;")).toBe("&#xD800;");
  });

  it("still decodes the named entities", () => {
    expect(sanitizeRecursively("&lt;script&gt;")).toBe("<script>");
  });

  it("strips control characters used to split a flagged keyword", () => {
    expect(sanitizeRecursively("ev\u0000al(")).toBe("eval(");
    expect(sanitizeRecursively("ev&#0;al(")).toBe("eval(");
  });

  it("keeps tabs and newlines intact", () => {
    expect(sanitizeRecursively("a\tb\nc")).toBe("a\tb\nc");
  });

  it("still strips zero-width characters", () => {
    expect(sanitizeRecursively("ev\u200Bal(")).toBe("eval(");
  });
});
