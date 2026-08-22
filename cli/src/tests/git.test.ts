import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { GitError, isGitRepository, getStagedFiles, readStagedContent } from '../git.js';

const mockExec = execFileSync as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GitError', () => {
  it('has name GitError and correct message', () => {
    const err = new GitError('something failed');
    expect(err.name).toBe('GitError');
    expect(err.message).toBe('something failed');
    expect(err).toBeInstanceOf(Error);
  });

  it('stores cause', () => {
    const cause = new Error('root cause');
    const err = new GitError('wrapper', cause);
    expect(err.cause).toBe(cause);
  });
});

describe('isGitRepository', () => {
  it('returns true when git outputs "true"', () => {
    mockExec.mockReturnValue('true\n');
    expect(isGitRepository()).toBe(true);
  });

  it('returns false when git outputs something else', () => {
    mockExec.mockReturnValue('false\n');
    expect(isGitRepository()).toBe(false);
  });

  it('returns false when execFileSync throws', () => {
    mockExec.mockImplementation(() => { throw new Error('not found'); });
    expect(isGitRepository()).toBe(false);
  });
});

describe('getStagedFiles', () => {
  it('returns list of staged file paths', () => {
    mockExec.mockReturnValue('src/index.ts\u0000src/utils.ts\u0000');
    expect(getStagedFiles()).toEqual(['src/index.ts', 'src/utils.ts']);
  });

  it('returns empty array when nothing is staged', () => {
    mockExec.mockReturnValue('');
    expect(getStagedFiles()).toEqual([]);
  });

  it('throws GitError with "Not a git repository" when not in a repo', () => {
    // First call: diff --cached throws; second call: isGitRepository -> execFileSync throws
    mockExec
      .mockImplementationOnce(() => { throw new Error('not a repo'); })
      .mockImplementationOnce(() => { throw new Error('not a repo'); });
    expect(() => getStagedFiles()).toThrow(GitError);
    expect(() => {
      mockExec
        .mockImplementationOnce(() => { throw new Error('not a repo'); })
        .mockImplementationOnce(() => { throw new Error('not a repo'); });
      getStagedFiles();
    }).toThrow('Not a git repository');
  });

  it('throws GitError with "Could not list staged files" when inside a repo but diff fails', () => {
    mockExec
      .mockImplementationOnce(() => { throw new Error('diff failed'); })
      .mockReturnValueOnce('true\n');
    expect(() => getStagedFiles()).toThrow('Could not list staged files');
  });
});

describe('readStagedContent', () => {
  it('returns file content from git show', () => {
    mockExec.mockReturnValue('const x = 1;\n');
    expect(readStagedContent('src/index.ts')).toBe('const x = 1;\n');
  });

  it('returns null when git show throws', () => {
    mockExec.mockImplementation(() => { throw new Error('not found'); });
    expect(readStagedContent('missing.ts')).toBeNull();
  });
});
