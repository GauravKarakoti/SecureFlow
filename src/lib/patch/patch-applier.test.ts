import { describe, expect, it } from "vitest";
import { applyUnifiedPatchWithConflictDetection, parseUnifiedDiff } from "./patch-applier";
import { applyPatchWithFuzzyFallback } from "./patch-verifier";

const SAMPLE_SOURCE = [
  "import { db } from './db';",
  "",
  "export async function getUser(id: string) {",
  "  const query = `SELECT * FROM users WHERE id = ${id}`;",
  "  return db.query(query);",
  "}",
  "",
  "export function formatName(name: string) {",
  "  return name.trim();",
  "}",
  "",
].join("\n");

describe("Unified Diff Patch Applier & Conflict Detector", () => {
  it("parses unified diff headers and multi-hunk structures", () => {
    const patch = [
      "--- a/src/user.ts",
      "+++ b/src/user.ts",
      "@@ -3,4 +3,4 @@",
      " export async function getUser(id: string) {",
      "-  const query = `SELECT * FROM users WHERE id = ${id}`;",
      "-  return db.query(query);",
      "+  const query = 'SELECT * FROM users WHERE id = $1';",
      "+  return db.query(query, [id]);",
      " }",
      "@@ -8,3 +8,3 @@",
      " export function formatName(name: string) {",
      "-  return name.trim();",
      "+  return name.trim().toLowerCase();",
      " }",
    ].join("\n");

    const parsed = parseUnifiedDiff(patch);
    expect(parsed.parseError).toBeUndefined();
    expect(parsed.oldPath).toBe("src/user.ts");
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[0].lines).toHaveLength(6);
  });

  it("applies multi-hunk unified diff cleanly at exact offsets", () => {
    const patch = [
      "--- a/src/user.ts",
      "+++ b/src/user.ts",
      "@@ -3,4 +3,4 @@",
      " export async function getUser(id: string) {",
      "-  const query = `SELECT * FROM users WHERE id = ${id}`;",
      "-  return db.query(query);",
      "+  const query = 'SELECT * FROM users WHERE id = $1';",
      "+  return db.query(query, [id]);",
      " }",
      "@@ -8,3 +8,3 @@",
      " export function formatName(name: string) {",
      "-  return name.trim();",
      "+  return name.trim().toLowerCase();",
      " }",
      "",
    ].join("\n");

    const res = applyUnifiedPatchWithConflictDetection(SAMPLE_SOURCE, patch, {
      expectedFilePath: "src/user.ts",
    });

    expect(res.success).toBe(true);
    expect(res.conflicts).toEqual([]);
    expect(res.appliedHunks).toEqual([
      { hunkIndex: 0, expectedLine: 3, appliedLine: 3, offset: 0 },
      { hunkIndex: 1, expectedLine: 8, appliedLine: 8, offset: 0 },
    ]);
    expect(res.patchedContent).toContain("db.query(query, [id])");
    expect(res.patchedContent).toContain("name.trim().toLowerCase()");
  });

  it("applies a shifted hunk using bounded fuzzy line-offset matching", () => {
    const shiftedSource = ["// Banner line 1", "// Banner line 2", SAMPLE_SOURCE].join("\n");
    const patch = [
      "--- a/src/user.ts",
      "+++ b/src/user.ts",
      "@@ -3,4 +3,4 @@",
      " export async function getUser(id: string) {",
      "-  const query = `SELECT * FROM users WHERE id = ${id}`;",
      "-  return db.query(query);",
      "+  const query = 'SELECT * FROM users WHERE id = $1';",
      "+  return db.query(query, [id]);",
      " }",
      "",
    ].join("\n");

    const res = applyPatchWithFuzzyFallback(shiftedSource, patch, "src/user.ts", 5);
    expect(res.success).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.appliedHunks[0]).toEqual({
      hunkIndex: 0,
      expectedLine: 3,
      appliedLine: 5,
      offset: 2,
    });
    expect(res.patchedContent).toContain("// Banner line 1");
    expect(res.patchedContent).toContain("db.query(query, [id])");
  });

  it("detects overlapping hunks, header mismatches, and context conflicts", () => {
    const overlapping = ["@@ -3,4 +3,4 @@", " a", "@@ -5,2 +5,2 @@", " b"].join("\n");
    const overlapRes = applyUnifiedPatchWithConflictDetection(SAMPLE_SOURCE, overlapping);
    expect(overlapRes.success).toBe(false);
    expect(overlapRes.conflicts[0].reason).toBe("overlapping_hunks");

    const wrongFilePatch = [
      "--- a/src/other.ts",
      "+++ b/src/other.ts",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
    ].join("\n");
    const headerRes = applyUnifiedPatchWithConflictDetection(SAMPLE_SOURCE, wrongFilePatch, {
      expectedFilePath: "src/user.ts",
    });
    expect(headerRes.success).toBe(false);
    expect(headerRes.conflicts[0].reason).toBe("header_mismatch");

    const mismatchPatch = [
      "@@ -3,3 +3,3 @@",
      " export async function nonExistentFn() {",
      "-  return 1;",
      "+  return 2;",
      " }",
    ].join("\n");
    const mismatchRes = applyUnifiedPatchWithConflictDetection(SAMPLE_SOURCE, mismatchPatch, {
      maxFuzzyOffset: 3,
    });
    expect(mismatchRes.success).toBe(false);
    expect(mismatchRes.conflicts[0].reason).toBe("context_mismatch");
  });
});
