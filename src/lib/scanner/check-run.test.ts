import { describe, it, expect, vi } from "vitest";
import {
  postScanCheckRun,
  postScanErrorCheckRun,
  SCAN_CHECK_NAME,
  mapSeverityToAnnotationLevel,
  findingToAnnotation,
  buildCheckAnnotations,
  ANNOTATION_BATCH_SIZE,
} from "./check-run";

const mk = (checkRunId: number = 101) => ({
  rest: {
    checks: {
      create: vi.fn().mockResolvedValue({ data: { id: checkRunId } }),
      update: vi.fn().mockResolvedValue({ data: { id: checkRunId } }),
    },
  },
});

const base = { owner: "o", repo: "r", headSha: "abc", findingsCount: 1, fileCount: 2 };

describe("Check conclusion logic (unchanged)", () => {
  it("fails the check on BLOCKED", async () => {
    const o = mk();
    await postScanCheckRun(o, { ...base, decision: "BLOCKED" });
    expect(o.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: SCAN_CHECK_NAME, conclusion: "failure" }),
    );
  });

  it("succeeds on PASS", async () => {
    const o = mk();
    await postScanCheckRun(o, { ...base, decision: "PASS" });
    expect(o.rest.checks.create.mock.calls[0][0].conclusion).toBe("success");
  });

  it("is action_required on REVIEW REQUIRED", async () => {
    const o = mk();
    await postScanCheckRun(o, { ...base, decision: "REVIEW REQUIRED" });
    expect(o.rest.checks.create.mock.calls[0][0].conclusion).toBe("action_required");
  });

  it("appends the coverage notice to the summary", async () => {
    const o = mk();
    await postScanCheckRun(o, { ...base, decision: "PASS", notice: "Scan truncated" });
    expect(o.rest.checks.create.mock.calls[0][0].output.summary).toContain("Scan truncated");
  });

  it("preserves conclusion logic when findings and annotations are present", async () => {
    const o = mk();
    const findings = [
      {
        fileLocation: "src/index.ts",
        lineStart: 10,
        severity: "CRITICAL",
        description: "Critical bug",
      },
    ];
    await postScanCheckRun(o, { ...base, decision: "BLOCKED", findings });
    expect(o.rest.checks.create.mock.calls[0][0].conclusion).toBe("failure");

    await postScanCheckRun(o, { ...base, decision: "PASS", findings });
    expect(o.rest.checks.create.mock.calls[1][0].conclusion).toBe("success");

    await postScanCheckRun(o, { ...base, decision: "REVIEW REQUIRED", findings });
    expect(o.rest.checks.create.mock.calls[2][0].conclusion).toBe("action_required");
  });
});

describe("postScanErrorCheckRun", () => {
  it("is fail-closed", async () => {
    const o = mk();
    await postScanErrorCheckRun(o, { owner: "o", repo: "r", headSha: "abc", reason: "boom" });
    const arg = o.rest.checks.create.mock.calls[0][0];
    expect(arg.name).toBe(SCAN_CHECK_NAME);
    expect(arg.conclusion).toBe("failure");
    expect(arg.output.summary).toContain("boom");
  });
});

describe("mapSeverityToAnnotationLevel", () => {
  it("maps CRITICAL and HIGH to failure", () => {
    expect(mapSeverityToAnnotationLevel("CRITICAL")).toBe("failure");
    expect(mapSeverityToAnnotationLevel("critical")).toBe("failure");
    expect(mapSeverityToAnnotationLevel("HIGH")).toBe("failure");
    expect(mapSeverityToAnnotationLevel("high")).toBe("failure");
    expect(mapSeverityToAnnotationLevel("ERROR")).toBe("failure");
    expect(mapSeverityToAnnotationLevel("SEV1")).toBe("failure");
  });

  it("maps MEDIUM to warning", () => {
    expect(mapSeverityToAnnotationLevel("MEDIUM")).toBe("warning");
    expect(mapSeverityToAnnotationLevel("medium")).toBe("warning");
    expect(mapSeverityToAnnotationLevel("WARN")).toBe("warning");
    expect(mapSeverityToAnnotationLevel("WARNING")).toBe("warning");
    expect(mapSeverityToAnnotationLevel("MODERATE")).toBe("warning");
  });

  it("maps LOW, INFO, and NONE to notice", () => {
    expect(mapSeverityToAnnotationLevel("LOW")).toBe("notice");
    expect(mapSeverityToAnnotationLevel("low")).toBe("notice");
    expect(mapSeverityToAnnotationLevel("INFO")).toBe("notice");
    expect(mapSeverityToAnnotationLevel("NONE")).toBe("notice");
    expect(mapSeverityToAnnotationLevel("NOTE")).toBe("notice");
  });

  it("falls back to warning for unknown or null severities", () => {
    expect(mapSeverityToAnnotationLevel(null)).toBe("warning");
    expect(mapSeverityToAnnotationLevel(undefined)).toBe("warning");
    expect(mapSeverityToAnnotationLevel("UNKNOWN_VALUE")).toBe("warning");
  });
});

describe("findingToAnnotation", () => {
  it("maps a finding with fileLocation, line range, and severity to an annotation", () => {
    const annotation = findingToAnnotation({
      fileLocation: "src/auth/jwt.ts",
      lineStart: 12,
      lineEnd: 15,
      severity: "HIGH",
      type: "VULNERABILITY",
      description: "Insecure JWT signing",
      codeSnippet: "jwt.sign(payload, secret, { algorithm: 'none' })",
    });

    expect(annotation).toEqual({
      path: "src/auth/jwt.ts",
      start_line: 12,
      end_line: 15,
      annotation_level: "failure",
      title: "VULNERABILITY",
      message: "Insecure JWT signing\n\njwt.sign(payload, secret, { algorithm: 'none' })",
      raw_details: "jwt.sign(payload, secret, { algorithm: 'none' })",
    });
  });

  it("normalizes path with leading slashes or Windows backslashes", () => {
    const annotation = findingToAnnotation({
      fileLocation: ".\\src\\services\\user.ts",
      lineStart: 5,
      severity: "LOW",
    });

    expect(annotation?.path).toBe("src/services/user.ts");
    expect(annotation?.start_line).toBe(5);
    expect(annotation?.end_line).toBe(5);
    expect(annotation?.annotation_level).toBe("notice");
  });

  it("defaults end_line to start_line if lineEnd is omitted or before start_line", () => {
    const singleLine = findingToAnnotation({
      fileLocation: "src/config.ts",
      lineStart: 18,
      severity: "MEDIUM",
    });
    expect(singleLine?.start_line).toBe(18);
    expect(singleLine?.end_line).toBe(18);

    const reversed = findingToAnnotation({
      fileLocation: "src/config.ts",
      lineStart: 25,
      lineEnd: 20,
      severity: "MEDIUM",
    });
    expect(reversed?.start_line).toBe(25);
    expect(reversed?.end_line).toBe(25);
  });

  it("skips findings without line information", () => {
    expect(findingToAnnotation({ fileLocation: "src/main.ts" })).toBeNull();
    expect(findingToAnnotation({ fileLocation: "src/main.ts", lineStart: null })).toBeNull();
    expect(findingToAnnotation({ fileLocation: "src/main.ts", lineStart: undefined })).toBeNull();
    expect(findingToAnnotation({ fileLocation: "src/main.ts", lineStart: 0 })).toBeNull();
    expect(findingToAnnotation({ fileLocation: "src/main.ts", lineStart: -10 })).toBeNull();
    expect(findingToAnnotation({ fileLocation: "src/main.ts", lineStart: "invalid" })).toBeNull();
  });

  it("skips findings without file information", () => {
    expect(findingToAnnotation({ lineStart: 10, severity: "HIGH" })).toBeNull();
    expect(findingToAnnotation({ fileLocation: "", lineStart: 10 })).toBeNull();
    expect(findingToAnnotation({ fileLocation: "   ", lineStart: 10 })).toBeNull();
  });

  it("never puts a secret value in an annotation; uses the redacted snippet", () => {
    const rawSecret = "ghp_1234567890abcdefghijklmnopqrstuvwxyz1234";
    const snippetWithSecret = `const token = "${rawSecret}";`;
    const descWithSecret = `Exposed secret token: ${rawSecret}`;

    const annotation = findingToAnnotation({
      fileLocation: "src/credentials.ts",
      lineStart: 7,
      lineEnd: 7,
      type: "SECRET",
      severity: "CRITICAL",
      description: descWithSecret,
      codeSnippet: snippetWithSecret,
    });

    expect(annotation).not.toBeNull();
    const serialized = JSON.stringify(annotation);

    // Ensure raw secret is NEVER in the annotation
    expect(serialized).not.toContain(rawSecret);

    // Ensure the redacted snippet is used
    expect(annotation?.raw_details).toContain("[REDACTED_BY_THE_PROFESSOR]");
    expect(annotation?.message).toContain("[REDACTED_BY_THE_PROFESSOR]");
    expect(annotation?.message).toContain('const token = "[REDACTED_BY_THE_PROFESSOR]";');
    expect(annotation?.annotation_level).toBe("failure");
  });
});

describe("buildCheckAnnotations", () => {
  it("filters out invalid findings and returns only valid annotations", () => {
    const findings = [
      { fileLocation: "src/a.ts", lineStart: 1, severity: "LOW" },
      { fileLocation: "src/b.ts" }, // missing line
      null,
      { lineStart: 5, severity: "HIGH" }, // missing file
      { fileLocation: "src/c.ts", lineStart: 10, lineEnd: 12, severity: "HIGH" },
    ];

    const annotations = buildCheckAnnotations(findings);
    expect(annotations).toHaveLength(2);
    expect(annotations[0].path).toBe("src/a.ts");
    expect(annotations[1].path).toBe("src/c.ts");
  });

  it("handles empty or null findings gracefully", () => {
    expect(buildCheckAnnotations([])).toEqual([]);
    expect(buildCheckAnnotations(null)).toEqual([]);
    expect(buildCheckAnnotations(undefined)).toEqual([]);
  });
});

describe("Batching annotations (Checks API limit of 50 per call)", () => {
  it("sends up to 50 annotations in a single checks.create call", async () => {
    const o = mk();
    const findings = Array.from({ length: 50 }, (_, i) => ({
      fileLocation: `src/file-${i}.ts`,
      lineStart: i + 1,
      lineEnd: i + 1,
      severity: "HIGH",
      description: `Issue ${i + 1}`,
    }));

    await postScanCheckRun(o, { ...base, decision: "PASS", findings });

    expect(o.rest.checks.create).toHaveBeenCalledTimes(1);
    const createArg = o.rest.checks.create.mock.calls[0][0];
    expect(createArg.output.annotations).toHaveLength(50);
    expect(o.rest.checks.update).not.toHaveBeenCalled();
  });

  it("batches annotations with more than 50 findings across create and update calls", async () => {
    const o = mk(456);
    // 125 findings: batch 1 = 50, batch 2 = 50, batch 3 = 25
    const findings = Array.from({ length: 125 }, (_, i) => ({
      fileLocation: `src/file-${i}.ts`,
      lineStart: i + 1,
      lineEnd: i + 1,
      severity: i % 2 === 0 ? "CRITICAL" : "MEDIUM",
      description: `Finding number ${i + 1}`,
      codeSnippet: `console.log('line ${i + 1}');`,
    }));

    await postScanCheckRun(o, {
      ...base,
      decision: "BLOCKED",
      findingsCount: 125,
      findings,
    });

    // 1 create call with 50 annotations
    expect(o.rest.checks.create).toHaveBeenCalledTimes(1);
    const createArg = o.rest.checks.create.mock.calls[0][0];
    expect(createArg.conclusion).toBe("failure");
    expect(createArg.output.annotations).toHaveLength(ANNOTATION_BATCH_SIZE);
    expect(createArg.output.annotations[0].path).toBe("src/file-0.ts");
    expect(createArg.output.annotations[49].path).toBe("src/file-49.ts");

    // 2 update calls for the remaining 75 annotations (50 and 25)
    expect(o.rest.checks.update).toHaveBeenCalledTimes(2);

    const update1 = o.rest.checks.update.mock.calls[0][0];
    expect(update1.check_run_id).toBe(456);
    expect(update1.output.annotations).toHaveLength(50);
    expect(update1.output.annotations[0].path).toBe("src/file-50.ts");
    expect(update1.output.annotations[49].path).toBe("src/file-99.ts");

    const update2 = o.rest.checks.update.mock.calls[1][0];
    expect(update2.check_run_id).toBe(456);
    expect(update2.output.annotations).toHaveLength(25);
    expect(update2.output.annotations[0].path).toBe("src/file-100.ts");
    expect(update2.output.annotations[24].path).toBe("src/file-124.ts");
  });

  it("handles exactly 51 findings (50 in create, 1 in update)", async () => {
    const o = mk(789);
    const findings = Array.from({ length: 51 }, (_, i) => ({
      fileLocation: `src/file-${i}.ts`,
      lineStart: i + 1,
      severity: "LOW",
    }));

    await postScanCheckRun(o, { ...base, decision: "PASS", findings });

    expect(o.rest.checks.create).toHaveBeenCalledTimes(1);
    expect(o.rest.checks.create.mock.calls[0][0].output.annotations).toHaveLength(50);

    expect(o.rest.checks.update).toHaveBeenCalledTimes(1);
    expect(o.rest.checks.update.mock.calls[0][0].check_run_id).toBe(789);
    expect(o.rest.checks.update.mock.calls[0][0].output.annotations).toHaveLength(1);
  });

  it("does not include annotations key if no valid annotations exist", async () => {
    const o = mk();
    await postScanCheckRun(o, {
      ...base,
      decision: "PASS",
      findings: [{ fileLocation: "src/no-line.ts" }],
    });

    expect(o.rest.checks.create).toHaveBeenCalledTimes(1);
    expect(o.rest.checks.create.mock.calls[0][0].output.annotations).toBeUndefined();
    expect(o.rest.checks.update).not.toHaveBeenCalled();
  });
});
