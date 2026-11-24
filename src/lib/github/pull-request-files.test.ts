import { describe, it, expect, vi } from "vitest";
import {
  MAX_LISTED_UNDIFFED_FILES,
  undiffedFiles,
  DEFAULT_MAX_PR_FILES,
  PR_FILES_PAGE_SIZE,
  GITHUB_SINGLE_DIFF_FILE_LIMIT,
  fetchPullRequestFiles,
  formatCoverageNotice,
  isDiffTooLargeError,
  isDiffResponseTruncated,
  determineUnscannedReason,
  getUnscannedFiles,
  parseMultiFileUnifiedDiff,
  type PullRequestFile,
} from "./pull-request-files";

/** Build `count` fake changed files, numbered so order is checkable. */
function makeFiles(count: number, offset = 0): PullRequestFile[] {
  return Array.from({ length: count }, (_, i) => ({
    filename: `src/file-${offset + i}.ts`,
    status: "modified",
    patch: `@@ -1 +1 @@\n+const x = ${offset + i};`,
  }));
}

/**
 * Minimal Octokit stand-in that serves `pages` through `paginate.iterator`,
 * recording how many pages were actually pulled so we can assert the walk stops
 * early instead of buffering everything.
 */
function makeOctokit(pages: PullRequestFile[][]) {
  const pagesRequested: number[] = [];
  const iterator = vi.fn(async function* (_route: unknown, params: Record<string, unknown>) {
    for (let i = 0; i < pages.length; i++) {
      pagesRequested.push(i);
      yield { data: pages[i] };
    }
    void params;
  });

  return {
    octokit: {
      paginate: { iterator },
      rest: { pulls: { listFiles: "GET /repos/{owner}/{repo}/pulls/{pull_number}/files" } },
    } as never,
    iterator,
    pagesRequested,
  };
}

const baseOptions = { owner: "acme", repo: "api", pullNumber: 42 };

describe("fetchPullRequestFiles", () => {
  it("returns every file across multiple pages", async () => {
    const { octokit } = makeOctokit([makeFiles(100, 0), makeFiles(100, 100), makeFiles(35, 200)]);

    const result = await fetchPullRequestFiles(octokit, baseOptions);

    // The pre-fix code stopped at 30. This is the regression that matters.
    expect(result.fetched).toBe(235);
    expect(result.files).toHaveLength(235);
    expect(result.truncated).toBe(false);
  });

  it("requests the maximum page size rather than the default 30", async () => {
    const { octokit, iterator } = makeOctokit([makeFiles(5)]);

    await fetchPullRequestFiles(octokit, baseOptions);

    expect(iterator).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        owner: "acme",
        repo: "api",
        pull_number: 42,
        per_page: PR_FILES_PAGE_SIZE,
      }),
    );
  });

  it("preserves file order across pages", async () => {
    const { octokit } = makeOctokit([makeFiles(2, 0), makeFiles(2, 2)]);

    const result = await fetchPullRequestFiles(octokit, baseOptions);

    expect(result.files.map((f) => f.filename)).toEqual([
      "src/file-0.ts",
      "src/file-1.ts",
      "src/file-2.ts",
      "src/file-3.ts",
    ]);
  });

  it("handles a pull request with no changed files", async () => {
    const { octokit } = makeOctokit([[]]);

    const result = await fetchPullRequestFiles(octokit, baseOptions);

    expect(result.files).toEqual([]);
    expect(result.fetched).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.totalChanged).toBe(0);
  });

  it("stops at maxFiles and flags truncation", async () => {
    const { octokit } = makeOctokit([makeFiles(100, 0), makeFiles(100, 100)]);

    const result = await fetchPullRequestFiles(octokit, { ...baseOptions, maxFiles: 120 });

    expect(result.fetched).toBe(120);
    expect(result.truncated).toBe(true);
  });

  it("stops walking pages once the cap is reached", async () => {
    const { octokit, pagesRequested } = makeOctokit([
      makeFiles(100, 0),
      makeFiles(100, 100),
      makeFiles(100, 200),
      makeFiles(100, 300),
    ]);

    await fetchPullRequestFiles(octokit, { ...baseOptions, maxFiles: 150 });

    // Two pages is enough to reach 150; the remaining pages must not be fetched.
    expect(pagesRequested).toEqual([0, 1]);
  });

  it("reports the exact total when changed_files is supplied", async () => {
    const { octokit } = makeOctokit([makeFiles(50)]);

    const result = await fetchPullRequestFiles(octokit, {
      ...baseOptions,
      maxFiles: 50,
      changedFiles: 412,
    });

    expect(result.truncated).toBe(true);
    expect(result.totalChanged).toBe(412);
  });

  it("reports an unknown total when capped without changed_files", async () => {
    const { octokit } = makeOctokit([makeFiles(100), makeFiles(100)]);

    const result = await fetchPullRequestFiles(octokit, { ...baseOptions, maxFiles: 10 });

    expect(result.truncated).toBe(true);
    expect(result.totalChanged).toBeNull();
  });

  it("flags truncation when changed_files exceeds what the API returned", async () => {
    // GitHub caps this endpoint at 3000 files, so the payload total can exceed
    // what pagination yields even below our own cap.
    const { octokit } = makeOctokit([makeFiles(20)]);

    const result = await fetchPullRequestFiles(octokit, { ...baseOptions, changedFiles: 95 });

    expect(result.fetched).toBe(20);
    expect(result.truncated).toBe(true);
  });

  it("does not flag truncation when changed_files matches the fetched count", async () => {
    const { octokit } = makeOctokit([makeFiles(20)]);

    const result = await fetchPullRequestFiles(octokit, { ...baseOptions, changedFiles: 20 });

    expect(result.truncated).toBe(false);
    expect(result.totalChanged).toBe(20);
  });

  it("defaults maxFiles to DEFAULT_MAX_PR_FILES", async () => {
    const { octokit } = makeOctokit([
      makeFiles(100, 0),
      makeFiles(100, 100),
      makeFiles(100, 200),
      makeFiles(100, 300),
    ]);

    const result = await fetchPullRequestFiles(octokit, baseOptions);

    expect(result.fetched).toBe(DEFAULT_MAX_PR_FILES);
    expect(result.truncated).toBe(true);
  });

  it("treats a non-positive maxFiles as one file rather than fetching nothing", async () => {
    const { octokit } = makeOctokit([makeFiles(10)]);

    const result = await fetchPullRequestFiles(octokit, { ...baseOptions, maxFiles: 0 });

    expect(result.fetched).toBe(1);
  });

  it("tolerates a page with no data array", async () => {
    const iterator = vi.fn(async function* () {
      yield { data: undefined as never };
      yield { data: makeFiles(3) };
    });
    const octokit = {
      paginate: { iterator },
      rest: { pulls: { listFiles: "route" } },
    } as never;

    const result = await fetchPullRequestFiles(octokit, baseOptions);

    expect(result.fetched).toBe(3);
  });

  it("ignores a negative changed_files value", async () => {
    const { octokit } = makeOctokit([makeFiles(4)]);

    const result = await fetchPullRequestFiles(octokit, { ...baseOptions, changedFiles: -1 });

    expect(result.truncated).toBe(false);
    expect(result.totalChanged).toBe(4);
  });
});

describe("formatCoverageNotice", () => {
  it("returns null when the whole pull request was analysed", () => {
    expect(
      formatCoverageNotice({ files: [], fetched: 12, truncated: false, totalChanged: 12 }),
    ).toBeNull();
  });

  it("states both counts when the total is known", () => {
    const notice = formatCoverageNotice({
      files: [],
      fetched: 300,
      truncated: true,
      totalChanged: 412,
    });

    expect(notice).toContain("300 of 412");
    expect(notice).toContain("112 file(s)");
  });

  it("still warns when the total is unknown", () => {
    const notice = formatCoverageNotice({
      files: [],
      fetched: 300,
      truncated: true,
      totalChanged: null,
    });

    expect(notice).toContain("300");
    expect(notice).toContain("not");
  });
});

describe("files GitHub returned without a diff", () => {
  const file = (filename: string, overrides: Partial<PullRequestFile> = {}): PullRequestFile => ({
    filename,
    status: "modified",
    patch: "@@ -1 +1 @@\n+x",
    ...overrides,
  });

  it("lists changed text files that came back without a patch", () => {
    expect(
      undiffedFiles([
        file("src/app.ts"),
        file("lib/vendor-bundle.js", { patch: undefined }),
        file("config/huge.json", { patch: "" }),
      ]),
    ).toEqual(["lib/vendor-bundle.js", "config/huge.json"]);
  });

  it("leaves out removed files and files the scanner ignores anyway", () => {
    expect(
      undiffedFiles([
        file("src/old.ts", { status: "removed", patch: undefined }),
        file("public/logo.png", { patch: undefined }),
        file("package-lock.json", { patch: undefined }),
        file("node_modules/pkg/index.js", { patch: undefined }),
      ]),
    ).toEqual([]);
  });

  it("warns about them even when the file list was not truncated", () => {
    // These used to be dropped silently, and the report still read "No
    // vulnerabilities found in the N analyzed files".
    const notice = formatCoverageNotice({
      files: [file("src/app.ts"), file("vendor/sdk.js", { patch: undefined })],
      fetched: 2,
      truncated: false,
      totalChanged: 2,
    });

    expect(notice).toContain("1 changed file(s) were **not** analysed");
    expect(notice).toContain("`vendor/sdk.js`");
  });

  it("caps the listed names and says how many more there are", () => {
    const many = Array.from({ length: MAX_LISTED_UNDIFFED_FILES + 3 }, (_, i) =>
      file(`gen/file-${i}.js`, { patch: undefined }),
    );
    const notice = formatCoverageNotice({
      files: many,
      fetched: many.length,
      truncated: false,
      totalChanged: many.length,
    })!;

    expect(notice).toContain(`${many.length} changed file(s)`);
    expect(notice).toContain("and 3 more");
    expect(notice).not.toContain(`gen/file-${MAX_LISTED_UNDIFFED_FILES}.js`);
  });

  it("combines with the truncation notice", () => {
    const notice = formatCoverageNotice({
      files: [file("big.sql", { patch: undefined })],
      fetched: 300,
      truncated: true,
      totalChanged: 412,
    })!;

    expect(notice).toContain("300 of 412");
    expect(notice).toContain("`big.sql`");
    expect(notice.split("\n\n")).toHaveLength(2);
  });

  it("keeps a backtick in a file name from breaking the code span", () => {
    const notice = formatCoverageNotice({
      files: [file("odd`name.js", { patch: undefined })],
      fetched: 1,
      truncated: false,
      totalChanged: 1,
    });
    expect(notice).toContain("`odd'name.js`");
  });
});

describe("diff too large detection and per-file pagination fallback (#2015)", () => {
  function makeOctokitWithDiff(options: {
    pages?: PullRequestFile[][];
    diffData?: string;
    diffStatus?: number;
    diffHeaders?: Record<string, unknown>;
    diffError?: unknown;
  }) {
    const pages = options.pages ?? [];
    const pagesRequested: number[] = [];
    const iterator = vi.fn(async function* (_route: unknown, params: Record<string, unknown>) {
      for (let i = 0; i < pages.length; i++) {
        pagesRequested.push(i);
        yield { data: pages[i] };
      }
      void params;
    });

    const get = vi.fn(async (_params: unknown) => {
      if (options.diffError) {
        throw options.diffError;
      }
      return {
        data: options.diffData ?? "",
        status: options.diffStatus ?? 200,
        headers: options.diffHeaders ?? {},
      };
    });

    return {
      octokit: {
        paginate: { iterator },
        rest: {
          pulls: {
            listFiles: "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
            get,
          },
        },
      } as never,
      iterator,
      get,
      pagesRequested,
    };
  }

  describe("isDiffTooLargeError", () => {
    it("recognizes status 406 as diff too large", () => {
      expect(isDiffTooLargeError({ status: 406 })).toBe(true);
      expect(isDiffTooLargeError({ statusCode: 406 })).toBe(true);
    });

    it("recognizes error messages indicating diff too large", () => {
      expect(isDiffTooLargeError(new Error("Diff too large"))).toBe(true);
      expect(isDiffTooLargeError(new Error("Not Acceptable: diff too large to display"))).toBe(
        true,
      );
      expect(isDiffTooLargeError({ message: "exceeded diff limit" })).toBe(true);
    });

    it("returns false for unrelated errors", () => {
      expect(isDiffTooLargeError(null)).toBe(false);
      expect(isDiffTooLargeError(undefined)).toBe(false);
      expect(isDiffTooLargeError(new Error("Resource not found"))).toBe(false);
      expect(isDiffTooLargeError({ status: 500, message: "Internal server error" })).toBe(false);
    });
  });

  describe("isDiffResponseTruncated", () => {
    it("recognizes diff truncation headers", () => {
      expect(isDiffResponseTruncated({ headers: { "x-github-diff-truncated": "true" } })).toBe(
        true,
      );
      expect(isDiffResponseTruncated({ headers: { "x-github-truncated": "true" } })).toBe(true);
    });

    it("recognizes truncation strings in diff body", () => {
      expect(isDiffResponseTruncated({ data: "Warning: Diff is too large to show" })).toBe(true);
      expect(isDiffResponseTruncated({ data: "diff ...diff truncated..." })).toBe(true);
    });

    it("returns false for regular responses", () => {
      expect(isDiffResponseTruncated({ data: "diff --git a/a.ts b/a.ts" })).toBe(false);
    });
  });

  describe("parseMultiFileUnifiedDiff", () => {
    it("parses multiple files, statuses, and patches", () => {
      const rawDiff = [
        "diff --git a/src/index.ts b/src/index.ts",
        "index 111..222 100644",
        "--- a/src/index.ts",
        "+++ b/src/index.ts",
        "@@ -1,2 +1,3 @@",
        " const a = 1;",
        "+const b = 2;",
        "diff --git a/src/new-file.ts b/src/new-file.ts",
        "new file mode 100644",
        "index 000..333",
        "--- /dev/null",
        "+++ b/src/new-file.ts",
        "@@ -0,0 +1,2 @@",
        "+export const x = 10;",
        "diff --git a/assets/icon.png b/assets/icon.png",
        "new file mode 100644",
        "Binary files /dev/null and b/assets/icon.png differ",
      ].join("\n");

      const files = parseMultiFileUnifiedDiff(rawDiff);
      expect(files).toHaveLength(3);

      expect(files[0].filename).toBe("src/index.ts");
      expect(files[0].status).toBe("modified");
      expect(files[0].patch).toContain("+const b = 2;");

      expect(files[1].filename).toBe("src/new-file.ts");
      expect(files[1].status).toBe("added");
      expect(files[1].patch).toContain("+export const x = 10;");

      expect(files[2].filename).toBe("assets/icon.png");
      expect(files[2].status).toBe("added");
      expect(files[2].patch).toBeUndefined();
    });
  });

  describe("getUnscannedFiles and determineUnscannedReason", () => {
    it("categorizes binary files and diffs too large", () => {
      const files: PullRequestFile[] = [
        { filename: "src/normal.ts", patch: "@@ -1 +1 @@\n+ok" },
        { filename: "assets/logo.png", patch: undefined },
        { filename: "src/large-generated.ts", patch: undefined },
        { filename: "deleted.ts", status: "removed", patch: undefined },
      ];

      const unscanned = getUnscannedFiles(files);
      expect(unscanned).toEqual([
        { filename: "assets/logo.png", reason: "binary file" },
        { filename: "src/large-generated.ts", reason: "diff too large" },
      ]);
    });
  });

  describe("fallback behavior in fetchPullRequestFiles", () => {
    const rawDiff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,2 @@",
      " const a = 1;",
      "+const b = 2;",
    ].join("\n");

    it("normal-sized PR uses the diff endpoint path unchanged when successful", async () => {
      const { octokit, get, iterator } = makeOctokitWithDiff({
        diffData: rawDiff,
      });

      const result = await fetchPullRequestFiles(octokit, baseOptions);

      expect(get).toHaveBeenCalledTimes(1);
      expect(iterator).not.toHaveBeenCalled();
      expect(result.usedFallback).toBe(false);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].filename).toBe("src/a.ts");
      expect(result.files[0].patch).toContain("+const b = 2;");
      expect(result.unscannedFiles).toEqual([]);
    });

    it("falls back to listing changed files with pagination when GitHub returns 406 Not Acceptable", async () => {
      const error406 = new Error("Diff too large");
      (error406 as any).status = 406;

      const { octokit, get, iterator } = makeOctokitWithDiff({
        diffError: error406,
        pages: [
          [
            { filename: "src/file-1.ts", status: "modified", patch: "@@ -1 +1 @@\n+1" },
            { filename: "src/file-2.ts", status: "modified", patch: "@@ -1 +1 @@\n+2" },
            { filename: "docs/manual.pdf", status: "added", patch: undefined },
            { filename: "src/oversized.ts", status: "modified", patch: "" },
          ],
        ],
      });

      const result = await fetchPullRequestFiles(octokit, baseOptions);

      expect(get).toHaveBeenCalledTimes(1);
      expect(iterator).toHaveBeenCalledTimes(1);
      expect(result.usedFallback).toBe(true);
      expect(result.fetched).toBe(4);
      expect(result.files).toHaveLength(4);
      expect(result.unscannedFiles).toEqual([
        { filename: "docs/manual.pdf", reason: "binary file" },
        { filename: "src/oversized.ts", reason: "diff too large" },
      ]);
    });

    it("falls back to pagination when response indicates truncated diff", async () => {
      const { octokit, get, iterator } = makeOctokitWithDiff({
        diffData: "Warning: Diff is too large to show",
        diffHeaders: { "x-github-diff-truncated": "true" },
        pages: [[{ filename: "src/file-1.ts", status: "modified", patch: "@@ -1 +1 @@\n+1" }]],
      });

      const result = await fetchPullRequestFiles(octokit, baseOptions);

      expect(get).toHaveBeenCalledTimes(1);
      expect(iterator).toHaveBeenCalledTimes(1);
      expect(result.usedFallback).toBe(true);
      expect(result.fetched).toBe(1);
    });

    it("falls back to pagination directly when PR has more files than single-diff limit", async () => {
      const { octokit, get, iterator } = makeOctokitWithDiff({
        pages: [makeFiles(100, 0), makeFiles(100, 100), makeFiles(150, 200)],
      });

      const result = await fetchPullRequestFiles(octokit, {
        ...baseOptions,
        changedFiles: 350,
        maxFiles: 350,
      });

      // Bypasses single-diff get since changedFiles exceeds GITHUB_SINGLE_DIFF_FILE_LIMIT (300)
      expect(get).not.toHaveBeenCalled();
      expect(iterator).toHaveBeenCalledTimes(1);
      expect(result.usedFallback).toBe(true);
      expect(result.fetched).toBe(350);
      expect(result.totalChanged).toBe(350);
    });
  });
});
