import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_MAX_PR_FILES,
  PR_FILES_PAGE_SIZE,
  fetchPullRequestFiles,
  formatCoverageNotice,
  type PullRequestFile,
} from './pull-request-files';

/** Build `count` fake changed files, numbered so order is checkable. */
function makeFiles(count: number, offset = 0): PullRequestFile[] {
  return Array.from({ length: count }, (_, i) => ({
    filename: `src/file-${offset + i}.ts`,
    status: 'modified',
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
      rest: { pulls: { listFiles: 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files' } },
    } as never,
    iterator,
    pagesRequested,
  };
}

const baseOptions = { owner: 'acme', repo: 'api', pullNumber: 42 };

describe('fetchPullRequestFiles', () => {
  it('returns every file across multiple pages', async () => {
    const { octokit } = makeOctokit([makeFiles(100, 0), makeFiles(100, 100), makeFiles(35, 200)]);

    const result = await fetchPullRequestFiles(octokit, baseOptions);

    // The pre-fix code stopped at 30. This is the regression that matters.
    expect(result.fetched).toBe(235);
    expect(result.files).toHaveLength(235);
    expect(result.truncated).toBe(false);
  });

  it('requests the maximum page size rather than the default 30', async () => {
    const { octokit, iterator } = makeOctokit([makeFiles(5)]);

    await fetchPullRequestFiles(octokit, baseOptions);

    expect(iterator).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        owner: 'acme',
        repo: 'api',
        pull_number: 42,
        per_page: PR_FILES_PAGE_SIZE,
      })
    );
  });

  it('preserves file order across pages', async () => {
    const { octokit } = makeOctokit([makeFiles(2, 0), makeFiles(2, 2)]);

    const result = await fetchPullRequestFiles(octokit, baseOptions);

    expect(result.files.map((f) => f.filename)).toEqual([
      'src/file-0.ts',
      'src/file-1.ts',
      'src/file-2.ts',
      'src/file-3.ts',
    ]);
  });

  it('handles a pull request with no changed files', async () => {
    const { octokit } = makeOctokit([[]]);

    const result = await fetchPullRequestFiles(octokit, baseOptions);

    expect(result.files).toEqual([]);
    expect(result.fetched).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.totalChanged).toBe(0);
  });

  it('stops at maxFiles and flags truncation', async () => {
    const { octokit } = makeOctokit([makeFiles(100, 0), makeFiles(100, 100)]);

    const result = await fetchPullRequestFiles(octokit, { ...baseOptions, maxFiles: 120 });

    expect(result.fetched).toBe(120);
    expect(result.truncated).toBe(true);
  });

  it('stops walking pages once the cap is reached', async () => {
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

  it('reports the exact total when changed_files is supplied', async () => {
    const { octokit } = makeOctokit([makeFiles(50)]);

    const result = await fetchPullRequestFiles(octokit, {
      ...baseOptions,
      maxFiles: 50,
      changedFiles: 412,
    });

    expect(result.truncated).toBe(true);
    expect(result.totalChanged).toBe(412);
  });

  it('reports an unknown total when capped without changed_files', async () => {
    const { octokit } = makeOctokit([makeFiles(100), makeFiles(100)]);

    const result = await fetchPullRequestFiles(octokit, { ...baseOptions, maxFiles: 10 });

    expect(result.truncated).toBe(true);
    expect(result.totalChanged).toBeNull();
  });

  it('flags truncation when changed_files exceeds what the API returned', async () => {
    // GitHub caps this endpoint at 3000 files, so the payload total can exceed
    // what pagination yields even below our own cap.
    const { octokit } = makeOctokit([makeFiles(20)]);

    const result = await fetchPullRequestFiles(octokit, { ...baseOptions, changedFiles: 95 });

    expect(result.fetched).toBe(20);
    expect(result.truncated).toBe(true);
  });

  it('does not flag truncation when changed_files matches the fetched count', async () => {
    const { octokit } = makeOctokit([makeFiles(20)]);

    const result = await fetchPullRequestFiles(octokit, { ...baseOptions, changedFiles: 20 });

    expect(result.truncated).toBe(false);
    expect(result.totalChanged).toBe(20);
  });

  it('defaults maxFiles to DEFAULT_MAX_PR_FILES', async () => {
    const { octokit } = makeOctokit([makeFiles(100, 0), makeFiles(100, 100), makeFiles(100, 200), makeFiles(100, 300)]);

    const result = await fetchPullRequestFiles(octokit, baseOptions);

    expect(result.fetched).toBe(DEFAULT_MAX_PR_FILES);
    expect(result.truncated).toBe(true);
  });

  it('treats a non-positive maxFiles as one file rather than fetching nothing', async () => {
    const { octokit } = makeOctokit([makeFiles(10)]);

    const result = await fetchPullRequestFiles(octokit, { ...baseOptions, maxFiles: 0 });

    expect(result.fetched).toBe(1);
  });

  it('tolerates a page with no data array', async () => {
    const iterator = vi.fn(async function* () {
      yield { data: undefined as never };
      yield { data: makeFiles(3) };
    });
    const octokit = {
      paginate: { iterator },
      rest: { pulls: { listFiles: 'route' } },
    } as never;

    const result = await fetchPullRequestFiles(octokit, baseOptions);

    expect(result.fetched).toBe(3);
  });

  it('ignores a negative changed_files value', async () => {
    const { octokit } = makeOctokit([makeFiles(4)]);

    const result = await fetchPullRequestFiles(octokit, { ...baseOptions, changedFiles: -1 });

    expect(result.truncated).toBe(false);
    expect(result.totalChanged).toBe(4);
  });
});

describe('formatCoverageNotice', () => {
  it('returns null when the whole pull request was analysed', () => {
    expect(
      formatCoverageNotice({ files: [], fetched: 12, truncated: false, totalChanged: 12 })
    ).toBeNull();
  });

  it('states both counts when the total is known', () => {
    const notice = formatCoverageNotice({
      files: [],
      fetched: 300,
      truncated: true,
      totalChanged: 412,
    });

    expect(notice).toContain('300 of 412');
    expect(notice).toContain('112 file(s)');
  });

  it('still warns when the total is unknown', () => {
    const notice = formatCoverageNotice({
      files: [],
      fetched: 300,
      truncated: true,
      totalChanged: null,
    });

    expect(notice).toContain('300');
    expect(notice).toContain('not');
  });
});
