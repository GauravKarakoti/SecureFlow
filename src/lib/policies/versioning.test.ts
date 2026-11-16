import { describe, it, expect } from "vitest";
import { computeTextDiff } from "./versioning";

describe("computeTextDiff", () => {
  it("detects unchanged lines", () => {
    const diff = computeTextDiff("line 1\nline 2", "line 1\nline 2");
    expect(diff).toEqual([
      { type: "unchanged", content: "line 1" },
      { type: "unchanged", content: "line 2" },
    ]);
  });

  it("detects added lines", () => {
    const diff = computeTextDiff("line 1", "line 1\nline 2");
    expect(diff).toEqual([
      { type: "unchanged", content: "line 1" },
      { type: "added", content: "line 2" },
    ]);
  });

  it("detects removed lines", () => {
    const diff = computeTextDiff("line 1\nline 2", "line 1");
    expect(diff).toEqual([
      { type: "unchanged", content: "line 1" },
      { type: "removed", content: "line 2" },
    ]);
  });

  it("detects modified lines as removed then added", () => {
    const diff = computeTextDiff("old text", "new text");
    expect(diff).toEqual([
      { type: "removed", content: "old text" },
      { type: "added", content: "new text" },
    ]);
  });
});
