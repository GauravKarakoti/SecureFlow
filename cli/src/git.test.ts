import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileSyncMock = vi.fn();

vi.mock("child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

import {
  GitError,
  isGitRepository,
  refExists,
  getRepoRoot,
  getStagedFiles,
  getChangedFilesSince,
  readStagedContent,
  getCurrentBranch,
} from "./git.js";

describe("cli/src/git", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    execFileSyncMock.mockReset();
  });

  describe("GitError", () => {
    it("creates an error with name GitError, message, and cause", () => {
      const cause = new Error("exit code 128");
      const error = new GitError("Failed to invoke git", cause);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(GitError);
      expect(error.name).toBe("GitError");
      expect(error.message).toBe("Failed to invoke git");
      expect(error.cause).toBe(cause);
    });

    it("creates an error without cause", () => {
      const error = new GitError("Missing git repository");
      expect(error.cause).toBeUndefined();
      expect(error.name).toBe("GitError");
    });
  });

  describe("isGitRepository", () => {
    it("returns true when git rev-parse indicates inside work tree", () => {
      execFileSyncMock.mockReturnValue("true\n");

      const result = isGitRepository();

      expect(result).toBe(true);
      expect(execFileSyncMock).toHaveBeenCalledWith(
        "git",
        ["rev-parse", "--is-inside-work-tree"],
        expect.objectContaining({
          encoding: "utf-8",
          maxBuffer: 64 * 1024 * 1024,
        }),
      );
    });

    it("returns false when git rev-parse returns false", () => {
      execFileSyncMock.mockReturnValue("false\n");

      const result = isGitRepository();

      expect(result).toBe(false);
    });

    it("returns false when git command fails or throws", () => {
      execFileSyncMock.mockImplementation(() => {
        throw new Error("fatal: not a git repository");
      });

      const result = isGitRepository();

      expect(result).toBe(false);
    });
  });

  describe("getStagedFiles", () => {
    it("parses NUL-delimited list of staged files", () => {
      execFileSyncMock.mockReturnValue(
        "src/index.ts\u0000src/scanner.ts\u0000docs/README.md\u0000",
      );

      const files = getStagedFiles();

      expect(files).toEqual(["src/index.ts", "src/scanner.ts", "docs/README.md"]);
      expect(execFileSyncMock).toHaveBeenCalledWith(
        "git",
        ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"],
        expect.any(Object),
      );
    });

    it("returns empty array when no files are staged", () => {
      execFileSyncMock.mockReturnValue("");

      const files = getStagedFiles();

      expect(files).toEqual([]);
    });

    it("handles special characters, unicode, and spaces safely via NUL delimiter", () => {
      execFileSyncMock.mockReturnValue(
        'src/café.ts\u0000path with spaces/file.ts\u0000quote"file.ts\u0000',
      );

      const files = getStagedFiles();

      expect(files).toEqual(["src/café.ts", "path with spaces/file.ts", 'quote"file.ts']);
    });

    it("throws GitError when git diff fails inside a git repository", () => {
      // First call for getStagedFiles fails
      // Second call for isGitRepository inside catch succeeds
      execFileSyncMock
        .mockImplementationOnce(() => {
          throw new Error("fatal: bad revision");
        })
        .mockReturnValueOnce("true\n");

      expect(() => getStagedFiles()).toThrowError(
        /Could not list staged files\. `git diff --cached` failed\./,
      );
    });

    it("throws GitError when executed outside of a git repository", () => {
      execFileSyncMock.mockImplementation(() => {
        throw new Error("fatal: not a git repository");
      });

      expect(() => getStagedFiles()).toThrowError(
        /Not a git repository \(or git is not on PATH\)\./,
      );
    });
  });

  describe("readStagedContent", () => {
    it("returns staged file content as a string when git show succeeds", () => {
      const mockContent = 'console.log("secure code");\n';
      execFileSyncMock.mockReturnValue(mockContent);

      const content = readStagedContent("src/index.ts");

      expect(content).toBe(mockContent);
      expect(execFileSyncMock).toHaveBeenCalledWith(
        "git",
        ["show", ":src/index.ts"],
        expect.any(Object),
      );
    });

    it("returns null when git show fails (e.g. untracked or unreadable blob)", () => {
      execFileSyncMock.mockImplementation(() => {
        throw new Error("fatal: path 'src/missing.ts' does not exist in index");
      });

      const content = readStagedContent("src/missing.ts");

      expect(content).toBeNull();
    });

    it("handles binary or conflict blob failures gracefully", () => {
      execFileSyncMock.mockImplementation(() => {
        throw new Error("fatal: ambiguous argument : conflict marker");
      });

      const content = readStagedContent("binary.png");

      expect(content).toBeNull();
    });
  });

  describe("getCurrentBranch", () => {
    it("returns active branch name when git rev-parse --abbrev-ref HEAD succeeds", () => {
      execFileSyncMock.mockReturnValue("main\n");

      const branch = getCurrentBranch();

      expect(branch).toBe("main");
      expect(execFileSyncMock).toHaveBeenCalledWith(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        expect.any(Object),
      );
    });

    it("returns feature branch name with slashes and special characters", () => {
      execFileSyncMock.mockReturnValue("feat/user-auth-123\n");

      const branch = getCurrentBranch();

      expect(branch).toBe("feat/user-auth-123");
    });

    it("returns null when in detached HEAD state (output is HEAD)", () => {
      execFileSyncMock.mockReturnValue("HEAD\n");

      const branch = getCurrentBranch();

      expect(branch).toBeNull();
    });

    it("returns null when output is empty string", () => {
      execFileSyncMock.mockReturnValue("\n");

      const branch = getCurrentBranch();

      expect(branch).toBeNull();
    });

    it("returns null when git command throws or executed outside repository", () => {
      execFileSyncMock.mockImplementation(() => {
        throw new Error("fatal: not a git repository");
      });

      const branch = getCurrentBranch();

      expect(branch).toBeNull();
    });
  });

  describe("refExists", () => {
    it("returns true when git rev-parse --verify succeeds", () => {
      execFileSyncMock.mockReturnValue("abc1234\n");

      expect(refExists("origin/main")).toBe(true);
      expect(execFileSyncMock).toHaveBeenCalledWith(
        "git",
        ["rev-parse", "--verify", "origin/main"],
        expect.any(Object),
      );
    });

    it("returns false when git rev-parse --verify fails", () => {
      execFileSyncMock.mockImplementation(() => {
        throw new Error("fatal: Needed a single revision");
      });

      expect(refExists("nonexistent")).toBe(false);
    });
  });

  describe("getRepoRoot", () => {
    it("returns show-toplevel output when inside repository", () => {
      execFileSyncMock.mockReturnValue("/path/to/repo\n");

      expect(getRepoRoot()).toBe("/path/to/repo");
      expect(execFileSyncMock).toHaveBeenCalledWith(
        "git",
        ["rev-parse", "--show-toplevel"],
        expect.any(Object),
      );
    });

    it("falls back to cwd when command fails", () => {
      execFileSyncMock.mockImplementation(() => {
        throw new Error("fatal: not a git repository");
      });

      expect(getRepoRoot("/fallback/dir")).toBe("/fallback/dir");
    });
  });

  describe("getChangedFilesSince", () => {
    it("parses NUL-delimited list of changed files with --diff-filter=ACMR", () => {
      // isGitRepository call
      execFileSyncMock.mockReturnValueOnce("true\n");
      // refExists call
      execFileSyncMock.mockReturnValueOnce("hash\n");
      // git diff call
      execFileSyncMock.mockReturnValueOnce(
        "src/added.ts\u0000src/modified.ts\u0000src/renamed.ts\u0000",
      );

      const files = getChangedFilesSince("origin/main");

      expect(files).toEqual(["src/added.ts", "src/modified.ts", "src/renamed.ts"]);
      expect(execFileSyncMock).toHaveBeenCalledWith(
        "git",
        ["diff", "--name-only", "-z", "--diff-filter=ACMR", "origin/main"],
        expect.any(Object),
      );
    });

    it("returns empty array when no files have changed since ref", () => {
      execFileSyncMock.mockReturnValueOnce("true\n");
      execFileSyncMock.mockReturnValueOnce("hash\n");
      execFileSyncMock.mockReturnValueOnce("");

      const files = getChangedFilesSince("origin/main");
      expect(files).toEqual([]);
    });

    it("handles unicode and spaces in filenames", () => {
      execFileSyncMock.mockReturnValueOnce("true\n");
      execFileSyncMock.mockReturnValueOnce("hash\n");
      execFileSyncMock.mockReturnValueOnce("src/café.ts\u0000path with spaces/file.ts\u0000");

      const files = getChangedFilesSince("main");
      expect(files).toEqual(["src/café.ts", "path with spaces/file.ts"]);
    });

    it("throws GitError when outside a git repository", () => {
      execFileSyncMock.mockImplementation(() => {
        throw new Error("fatal: not a git repository");
      });

      expect(() => getChangedFilesSince("origin/main")).toThrowError(
        "Not a git repository (or git is not on PATH).",
      );
    });

    it("throws GitError when the specified git reference does not exist", () => {
      // isGitRepository succeeds
      execFileSyncMock.mockReturnValueOnce("true\n");
      // refExists fails
      execFileSyncMock.mockImplementationOnce(() => {
        throw new Error("fatal: Needed a single revision");
      });

      expect(() => getChangedFilesSince("nonexistent-ref")).toThrowError(
        'Git reference "nonexistent-ref" does not exist.',
      );
    });

    it("throws GitError when git diff fails inside a git repository", () => {
      execFileSyncMock.mockReturnValueOnce("true\n");
      execFileSyncMock.mockReturnValueOnce("hash\n");
      execFileSyncMock.mockImplementationOnce(() => {
        throw new Error("fatal: diff failed");
      });

      expect(() => getChangedFilesSince("origin/main")).toThrowError(
        'Could not list files changed since "origin/main". `git diff` failed.',
      );
    });
  });
});
