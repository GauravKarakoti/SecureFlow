import { describe, it, expect } from 'vitest';
import {
  REPO_AUDIT_SAMPLE_SIZE,
  REPO_SYNC_CONCURRENCY,
  auditRepositorySample,
  chunk,
  normalizeRepo,
  normalizeRepos,
  partitionByOwnership,
  syncAuditResource,
  type NormalizedRepo,
} from './repo-ownership';

function repo(id: number, fullName: string): NormalizedRepo {
  return { githubId: BigInt(id), fullName, owner: fullName.split('/')[0] };
}

describe('normalizeRepo (#657)', () => {
  it('maps a GitHub repository object onto the row shape', () => {
    expect(
      normalizeRepo({ id: 101, full_name: 'acme/api', owner: { login: 'acme' } })
    ).toEqual({ githubId: BigInt(101), fullName: 'acme/api', owner: 'acme' });
  });

  it('falls back to the owner segment of full_name when owner.login is absent', () => {
    expect(normalizeRepo({ id: 101, full_name: 'acme/api' })?.owner).toBe('acme');
    expect(normalizeRepo({ id: 101, full_name: 'acme/api', owner: null })?.owner).toBe('acme');
    expect(
      normalizeRepo({ id: 101, full_name: 'acme/api', owner: { login: '  ' } })?.owner
    ).toBe('acme');
  });

  it('accepts a string id, as the API sometimes returns', () => {
    expect(normalizeRepo({ id: '9007199254740993', full_name: 'acme/api' })?.githubId).toBe(
      BigInt('9007199254740993')
    );
  });

  it('returns null rather than throwing on an unusable id', () => {
    // `BigInt(repo.id)` was previously called unguarded inside a Promise.all,
    // so a SyntaxError here took the entire batch down.
    expect(normalizeRepo({ id: 'not-a-number', full_name: 'acme/api' })).toBeNull();
    expect(normalizeRepo({ id: null, full_name: 'acme/api' })).toBeNull();
    expect(normalizeRepo({ id: undefined, full_name: 'acme/api' })).toBeNull();
    expect(normalizeRepo({ id: '', full_name: 'acme/api' })).toBeNull();
  });

  it('returns null for a missing or malformed full_name', () => {
    expect(normalizeRepo({ id: 1 })).toBeNull();
    expect(normalizeRepo({ id: 1, full_name: '' })).toBeNull();
    expect(normalizeRepo({ id: 1, full_name: 'no-slash' })).toBeNull();
    expect(normalizeRepo(null)).toBeNull();
    expect(normalizeRepo(undefined)).toBeNull();
  });
});

describe('normalizeRepos (#657)', () => {
  it('keeps the usable entries and counts the rest', () => {
    const { usable, malformed } = normalizeRepos([
      { id: 1, full_name: 'acme/api' },
      { id: 'bad', full_name: 'acme/web' },
      null,
      { id: 3, full_name: 'acme/cli' },
    ]);

    expect(usable.map((r) => r.fullName)).toEqual(['acme/api', 'acme/cli']);
    expect(malformed).toBe(2);
  });

  it('handles an empty page', () => {
    expect(normalizeRepos([])).toEqual({ usable: [], malformed: 0 });
  });
});

describe('partitionByOwnership (#657)', () => {
  const alice = 'user-alice';
  const bob = 'user-bob';

  it('claims repositories that are not in the database yet', () => {
    const { claimable, foreign } = partitionByOwnership([repo(1, 'acme/api')], [], alice);

    expect(claimable.map((r) => r.fullName)).toEqual(['acme/api']);
    expect(foreign).toEqual([]);
  });

  it('keeps claiming repositories the caller already owns, so renames still track', () => {
    const { claimable, foreign } = partitionByOwnership(
      [repo(1, 'acme/api-renamed')],
      [{ githubId: BigInt(1), userId: alice }],
      alice
    );

    expect(claimable.map((r) => r.fullName)).toEqual(['acme/api-renamed']);
    expect(foreign).toEqual([]);
  });

  it('refuses to take a repository owned by another user', () => {
    // This is the whole bug: the upsert wrote `userId` in its update branch, so
    // whoever synced second took the row — and with it Bob's findings, code
    // snippets and triage notes.
    const { claimable, foreign } = partitionByOwnership(
      [repo(1, 'acme/api')],
      [{ githubId: BigInt(1), userId: bob }],
      alice
    );

    expect(claimable).toEqual([]);
    expect(foreign.map((r) => r.fullName)).toEqual(['acme/api']);
  });

  it('splits a mixed org installation correctly', () => {
    const { claimable, foreign } = partitionByOwnership(
      [repo(1, 'acme/api'), repo(2, 'acme/web'), repo(3, 'acme/cli')],
      [
        { githubId: BigInt(1), userId: alice },
        { githubId: BigInt(2), userId: bob },
      ],
      alice
    );

    expect(claimable.map((r) => r.fullName)).toEqual(['acme/api', 'acme/cli']);
    expect(foreign.map((r) => r.fullName)).toEqual(['acme/web']);
  });

  it('compares ids by value, so a number row and a bigint repo still match', () => {
    const { claimable, foreign } = partitionByOwnership(
      [repo(1, 'acme/api')],
      [{ githubId: 1 as unknown as bigint, userId: bob }],
      alice
    );

    expect(claimable).toEqual([]);
    expect(foreign).toHaveLength(1);
  });

  it('is stable when the ownership list is empty', () => {
    const repos = [repo(1, 'a/b'), repo(2, 'c/d')];

    expect(partitionByOwnership(repos, [], alice).claimable).toHaveLength(2);
  });
});

describe('chunk (#657)', () => {
  it('splits into consecutive groups', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns one group when everything fits', () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it('returns nothing for an empty list', () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it('rejects a nonsensical size rather than looping forever', () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(() => chunk([1], -1)).toThrow(RangeError);
  });

  it('bounds a large installation to the configured concurrency', () => {
    const repos = Array.from({ length: 250 }, (_, i) => repo(i, `acme/repo-${i}`));
    const batches = chunk(repos, REPO_SYNC_CONCURRENCY);

    expect(Math.max(...batches.map((b) => b.length))).toBe(REPO_SYNC_CONCURRENCY);
    expect(batches.flat()).toHaveLength(250);
  });
});

describe('syncAuditResource (#657)', () => {
  it('is a short identifier, not a list of every repository name', () => {
    expect(syncAuditResource(412, 98765)).toBe('installation:98765:412');
  });

  it('stays short for a large installation', () => {
    expect(syncAuditResource(10_000, 1).length).toBeLessThan(60);
  });

  it('handles an unknown installation id', () => {
    expect(syncAuditResource(0, null)).toBe('installation:unknown:0');
  });
});

describe('auditRepositorySample (#657)', () => {
  it('lists the names for a small installation', () => {
    expect(auditRepositorySample([repo(1, 'acme/api'), repo(2, 'acme/web')])).toEqual([
      'acme/api',
      'acme/web',
    ]);
  });

  it('is bounded, so a large installation cannot write one name per repository', () => {
    const many = Array.from({ length: REPO_AUDIT_SAMPLE_SIZE + 50 }, (_, i) =>
      repo(i, `acme/repo-${i}`)
    );

    expect(auditRepositorySample(many)).toHaveLength(REPO_AUDIT_SAMPLE_SIZE);
  });
});
