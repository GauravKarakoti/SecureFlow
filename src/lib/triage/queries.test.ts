import { beforeEach, describe, expect, it, vi } from 'vitest';

import prisma from '@/lib/prisma';
import {
  MAX_SUPPRESSED_FINGERPRINTS,
  MAX_TRIAGE_ROWS,
  getSuppressedFingerprints,
  getUserTriage,
  triageKey,
} from './queries';

/**
 * `src/lib/triage/queries.ts` had no test file at all before this (#689), which
 * is how an unbounded read on the dashboard's hot path went unnoticed. These
 * assert the *shape of the query* as much as the returned value: the bug was
 * never a wrong answer, it was the cost of arriving at it.
 */

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    level: 'debug',
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }),
  logger: {},
}));

const findMany = vi.fn();

beforeEach(() => {
  findMany.mockReset();
  (prisma as unknown as { findingTriage: { findMany: typeof findMany } }).findingTriage = {
    findMany,
  };
});

const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
  repositoryId: 'repo-1',
  fingerprint: 'fp-1',
  status: 'FALSE_POSITIVE',
  note: null,
  ...overrides,
});

describe('getSuppressedFingerprints', () => {
  it('filters by status in the database rather than over every row', async () => {
    // The read had no status filter at all: it loaded every triage row the user
    // owned and picked the suppressed ones out in a loop.
    findMany.mockResolvedValue([]);

    await getSuppressedFingerprints('user-1');

    const [args] = findMany.mock.calls[0];
    expect(args.where).toEqual({
      repository: { userId: 'user-1' },
      status: { in: ['FALSE_POSITIVE', 'IGNORED'] },
    });
  });

  it('selects only the fingerprint', async () => {
    // `note` is user-authored free text and unbounded, and no caller of this
    // function reads it.
    findMany.mockResolvedValue([]);

    await getSuppressedFingerprints('user-1');

    expect(findMany.mock.calls[0][0].select).toEqual({ fingerprint: true });
  });

  it('bounds the read', async () => {
    findMany.mockResolvedValue([]);

    await getSuppressedFingerprints('user-1');

    // One over the cap, so hitting it is distinguishable from landing on it.
    expect(findMany.mock.calls[0][0].take).toBe(MAX_SUPPRESSED_FINGERPRINTS + 1);
  });

  it('de-duplicates', async () => {
    // The old implementation used `.push`, so the same fingerprint on two
    // repositories appeared twice in the `notIn` list.
    findMany.mockResolvedValue([
      { fingerprint: 'fp-1' },
      { fingerprint: 'fp-2' },
      { fingerprint: 'fp-1' },
    ]);

    const result = await getSuppressedFingerprints('user-1');

    expect(result.fingerprints).toEqual(['fp-1', 'fp-2']);
  });

  it('offers a membership test alongside the list', async () => {
    findMany.mockResolvedValue([{ fingerprint: 'fp-1' }]);

    const result = await getSuppressedFingerprints('user-1');

    expect(result.has('fp-1')).toBe(true);
    expect(result.has('fp-9')).toBe(false);
  });

  it('reports nothing to exclude as an empty list', async () => {
    findMany.mockResolvedValue([]);

    const result = await getSuppressedFingerprints('user-1');

    expect(result.fingerprints).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('flags truncation and returns exactly the cap', async () => {
    findMany.mockResolvedValue(
      Array.from({ length: MAX_SUPPRESSED_FINGERPRINTS + 1 }, (_, i) => ({
        fingerprint: `fp-${i}`,
      }))
    );

    const result = await getSuppressedFingerprints('user-1');

    expect(result.truncated).toBe(true);
    expect(result.fingerprints).toHaveLength(MAX_SUPPRESSED_FINGERPRINTS);
  });

  it('does not flag truncation when the result lands exactly on the cap', async () => {
    findMany.mockResolvedValue(
      Array.from({ length: MAX_SUPPRESSED_FINGERPRINTS }, (_, i) => ({
        fingerprint: `fp-${i}`,
      }))
    );

    expect((await getSuppressedFingerprints('user-1')).truncated).toBe(false);
  });
});

describe('getUserTriage', () => {
  it('bounds the read', async () => {
    findMany.mockResolvedValue([]);

    await getUserTriage('user-1');

    expect(findMany.mock.calls[0][0].take).toBe(MAX_TRIAGE_ROWS + 1);
  });

  it('orders newest first, so a cap keeps the most recent decisions', async () => {
    findMany.mockResolvedValue([]);

    await getUserTriage('user-1');

    expect(findMany.mock.calls[0][0].orderBy).toEqual({ updatedAt: 'desc' });
  });

  it('builds the per-repository lookup', async () => {
    findMany.mockResolvedValue([
      row({ repositoryId: 'repo-1', fingerprint: 'fp-1', status: 'RESOLVED', note: 'fixed' }),
    ]);

    const { byKey } = await getUserTriage('user-1');

    expect(byKey.get(triageKey('repo-1', 'fp-1'))).toEqual({
      status: 'RESOLVED',
      note: 'fixed',
    });
  });

  it('collects only the suppressed statuses into the dismissed set', async () => {
    findMany.mockResolvedValue([
      row({ fingerprint: 'fp-open', status: 'OPEN' }),
      row({ fingerprint: 'fp-resolved', status: 'RESOLVED' }),
      row({ fingerprint: 'fp-fp', status: 'FALSE_POSITIVE' }),
      row({ fingerprint: 'fp-ignored', status: 'IGNORED' }),
    ]);

    const { suppressedFingerprints } = await getUserTriage('user-1');

    expect(suppressedFingerprints.sort()).toEqual(['fp-fp', 'fp-ignored']);
  });

  it('de-duplicates the dismissed set across repositories', async () => {
    findMany.mockResolvedValue([
      row({ repositoryId: 'repo-1', fingerprint: 'shared' }),
      row({ repositoryId: 'repo-2', fingerprint: 'shared' }),
    ]);

    const { suppressedFingerprints, byKey } = await getUserTriage('user-1');

    // One entry in the notIn list, two in the lookup — the lookup is keyed by
    // repository as well, so both rows are still addressable.
    expect(suppressedFingerprints).toEqual(['shared']);
    expect(byKey.size).toBe(2);
  });

  it('flags truncation and keeps exactly the cap', async () => {
    findMany.mockResolvedValue(
      Array.from({ length: MAX_TRIAGE_ROWS + 1 }, (_, i) =>
        row({ fingerprint: `fp-${i}`, repositoryId: `repo-${i}` })
      )
    );

    const result = await getUserTriage('user-1');

    expect(result.truncated).toBe(true);
    expect(result.byKey.size).toBe(MAX_TRIAGE_ROWS);
  });

  it('scopes to the repositories the user owns', async () => {
    findMany.mockResolvedValue([]);

    await getUserTriage('user-9');

    expect(findMany.mock.calls[0][0].where).toEqual({ repository: { userId: 'user-9' } });
  });

  it('returns empty structures for a user with no triage rows', async () => {
    findMany.mockResolvedValue([]);

    const result = await getUserTriage('user-1');

    expect(result.suppressedFingerprints).toEqual([]);
    expect(result.byKey.size).toBe(0);
    expect(result.truncated).toBe(false);
  });
});

describe('triageKey', () => {
  it('scopes a fingerprint to its repository', () => {
    expect(triageKey('repo-1', 'fp-1')).toBe('repo-1:fp-1');
  });

  it('keeps the same fingerprint distinct across repositories', () => {
    expect(triageKey('repo-1', 'fp')).not.toBe(triageKey('repo-2', 'fp'));
  });
});
