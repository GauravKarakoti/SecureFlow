import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileSyncMock = vi.fn();

vi.mock("child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

import { GitError, isGitRepository, getStagedFiles, readStagedContent } from "./git.js";

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
});
