import { describe, it, expect, vi } from "vitest";
import {
  extractPrNumberFromMergeGroup,
  fetchMergeGroupFiles,
  isMergeGroupDiffUnchanged,
} from "./merge-group";

describe("extractPrNumberFromMergeGroup", () => {
  it("extracts PR number from GitHub standard merge queue head_ref", () => {
    expect(
      extractPrNumberFromMergeGroup({
        head_ref: "refs/heads/gh-readonly-queue/main/pr-123-abc123def456",
      }),
    ).toBe(123);
  });

  it("extracts PR number from simple pr-number ref", () => {
    expect(
      extractPrNumberFromMergeGroup({
        head_ref: "gh-readonly-queue/main/pr-456",
      }),
    ).toBe(456);
  });

  it("extracts PR number from commit message with 'Merge pull request #123'", () => {
    expect(
      extractPrNumberFromMergeGroup({
        head_ref: "unknown-ref",
        head_commit: {
          message: "Merge pull request #789 from acme/feature-branch",
        },
      }),
    ).toBe(789);
  });

  it("extracts PR number from commit message with '(#123)' convention", () => {
    expect(
      extractPrNumberFromMergeGroup({
        head_ref: "unknown-ref",
        head_commit: {
          message: "feat: add user authentication (#999)",
        },
      }),
    ).toBe(999);
  });

  it("returns null when no PR number can be found", () => {
    expect(extractPrNumberFromMergeGroup(null)).toBeNull();
    expect(extractPrNumberFromMergeGroup({})).toBeNull();
    expect(
      extractPrNumberFromMergeGroup({
        head_ref: "refs/heads/main",
        head_commit: { message: "Initial commit" },
      }),
    ).toBeNull();
  });
});

describe("fetchMergeGroupFiles", () => {
  it("calls compareCommits and filters out files without patches or removed status", async () => {
    const mockCompare = vi.fn().mockResolvedValue({
      data: {
        files: [
          { filename: "src/app.ts", patch: "@@ -1,1 +1,2 @@\n+foo", status: "modified" },
          { filename: "src/deleted.ts", patch: "@@ -1,1 +0,0 @@\n-foo", status: "removed" },
          { filename: "binary.png", patch: undefined, status: "added" },
          { filename: "src/new.ts", patch: "@@ -0,0 +1,1 @@\n+bar", status: "added" },
        ],
      },
    });

    const client = {
      rest: {
        repos: {
          compareCommits: mockCompare,
        },
      },
    };

    const files = await fetchMergeGroupFiles(client, {
      owner: "acme",
      repo: "project",
      baseSha: "base123",
      headSha: "head456",
    });

    expect(mockCompare).toHaveBeenCalledWith({
      owner: "acme",
      repo: "project",
      base: "base123",
      head: "head456",
    });

    expect(files).toEqual([
      { filename: "src/app.ts", patch: "@@ -1,1 +1,2 @@\n+foo", status: "modified" },
      { filename: "src/new.ts", patch: "@@ -0,0 +1,1 @@\n+bar", status: "added" },
    ]);
  });
});

describe("isMergeGroupDiffUnchanged", () => {
  it("returns true when files and unified patches are identical", () => {
    const patch = "@@ -1,3 +1,4 @@\n context\n+new line\n context";
    const prFiles = [{ filename: "src/index.ts", patch }];
    const mergeFiles = [{ filename: "src/index.ts", patch }];

    expect(isMergeGroupDiffUnchanged(mergeFiles, prFiles)).toBe(true);
  });

  it("returns true regardless of file ordering", () => {
    const patchA = "@@ -0,0 +1,1 @@\n+line A";
    const patchB = "@@ -0,0 +1,1 @@\n+line B";

    const prFiles = [
      { filename: "b.ts", patch: patchB },
      { filename: "a.ts", patch: patchA },
    ];
    const mergeFiles = [
      { filename: "a.ts", patch: patchA },
      { filename: "b.ts", patch: patchB },
    ];

    expect(isMergeGroupDiffUnchanged(mergeFiles, prFiles)).toBe(true);
  });

  it("returns false when a file has additional or modified changes", () => {
    const patch1 = "@@ -1,1 +1,2 @@\n+line 1";
    const patch2 = "@@ -1,1 +1,3 @@\n+line 1\n+line 2";

    const prFiles = [{ filename: "src/index.ts", patch: patch1 }];
    const mergeFiles = [{ filename: "src/index.ts", patch: patch2 }];

    expect(isMergeGroupDiffUnchanged(mergeFiles, prFiles)).toBe(false);
  });

  it("returns false when merge group has extra files from base branch updates", () => {
    const patch = "@@ -0,0 +1,1 @@\n+line";

    const prFiles = [{ filename: "src/pr-file.ts", patch }];
    const mergeFiles = [
      { filename: "src/pr-file.ts", patch },
      { filename: "src/base-conflict.ts", patch },
    ];

    expect(isMergeGroupDiffUnchanged(mergeFiles, prFiles)).toBe(false);
  });
});
