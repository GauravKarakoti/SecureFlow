import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

vi.mock('../git.js', () => ({
  GitError: class GitError extends Error {
    constructor(message: string) { super(message); this.name = 'GitError'; }
  },
  getStagedFiles: vi.fn(),
  readStagedContent: vi.fn(),
}));

vi.mock('../scanner.js', () => ({
  scanFile: vi.fn(),
}));

import { parseArgs, formatFinding, main } from '../index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let gitMock: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let scannerMock: any;

beforeAll(async () => {
  gitMock = await vi.importMock('../git.js');
  scannerMock = await vi.importMock('../scanner.js');
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseArgs', () => {
  it('parses a flag with a value', () => {
    expect(parseArgs(['--repo', 'my-repo'])).toEqual({ repo: 'my-repo' });
  });

  it('parses a boolean flag', () => {
    expect(parseArgs(['--verbose'])).toEqual({ verbose: true });
  });

  it('parses multiple flags', () => {
    expect(parseArgs(['--repo', 'my-repo', '--verbose'])).toEqual({
      repo: 'my-repo',
      verbose: true,
    });
  });

  it('returns empty object for no args', () => {
    expect(parseArgs([])).toEqual({});
  });
});

describe('formatFinding', () => {
  it('formats a finding with a line number', () => {
    expect(
      formatFinding({ type: 'SQL_INJECTION', severity: 'HIGH', file: 'db.ts', line: 42 })
    ).toBe('[HIGH] SQL_INJECTION — db.ts:42');
  });

  it('formats a finding without a line number', () => {
    expect(
      formatFinding({ type: 'HARDCODED_SECRET', severity: 'CRITICAL', file: 'config.ts' })
    ).toBe('[CRITICAL] HARDCODED_SECRET — config.ts');
  });
});

describe('main()', () => {
  it('returns 0 when nothing is staged', () => {
    gitMock.getStagedFiles.mockReturnValue([]);
    expect(main()).toBe(0);
  });

  it('returns 1 when getStagedFiles throws a GitError', () => {
    gitMock.getStagedFiles.mockImplementation(() => {
      throw new gitMock.GitError('Not a git repository.');
    });
    expect(main()).toBe(1);
  });

  it('returns 1 when getStagedFiles throws a generic error', () => {
    gitMock.getStagedFiles.mockImplementation(() => { throw new Error('unexpected'); });
    expect(main()).toBe(1);
  });

  it('returns 0 when staged files have no violations', () => {
    gitMock.getStagedFiles.mockReturnValue(['src/index.ts']);
    gitMock.readStagedContent.mockReturnValue('const x = 1;');
    scannerMock.scanFile.mockReturnValue({ path: 'src/index.ts', violations: [] });
    expect(main()).toBe(0);
  });

  it('returns 1 when a staged file has violations', () => {
    gitMock.getStagedFiles.mockReturnValue(['src/index.ts']);
    gitMock.readStagedContent.mockReturnValue('console.log(process.env.SECRET)');
    scannerMock.scanFile.mockReturnValue({
      path: 'src/index.ts',
      violations: [{ line: 1, text: 'console.log(process.env.SECRET)', reason: 'environment variable' }],
    });
    expect(main()).toBe(1);
  });

  it('warns when readStagedContent returns null (unreadable file)', () => {
    gitMock.getStagedFiles.mockReturnValue(['sub/module']);
    gitMock.readStagedContent.mockReturnValue(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(main()).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not read'));
    warnSpy.mockRestore();
  });

  it('logs skipped files when --verbose is set', () => {
    const originalArgv = process.argv;
    process.argv = [...process.argv, '--verbose'];
    gitMock.getStagedFiles.mockReturnValue(['image.png']);
    gitMock.readStagedContent.mockReturnValue('data');
    scannerMock.scanFile.mockReturnValue({ path: 'image.png', violations: [], skipped: 'excluded by type or size' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main()).toBe(0);
    logSpy.mockRestore();
    process.argv = originalArgv;
  });
});
