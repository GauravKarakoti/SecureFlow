import { describe, it, expect, vi } from 'vitest';
import {
  buildScanJobData,
  loadOwnedRepository,
  loadScanJobOwnership,
  scanJobVisibility,
  scanRequestSchema,
  type RepositoryStore,
  type ScanJobOwnershipStore,
} from './scan-authorization';

function repositoryStore(row: { id: string; fullName: string } | null) {
  const findFirst = vi.fn().mockResolvedValue(row);
  return { findFirst } as unknown as RepositoryStore & { findFirst: ReturnType<typeof vi.fn> };
}

function scanJobStore(row: unknown) {
  const findUnique = vi.fn().mockResolvedValue(row);
  return { findUnique } as unknown as ScanJobOwnershipStore & {
    findUnique: ReturnType<typeof vi.fn>;
  };
}

const validBody = {
  repositoryId: 'repo-1',
  installationId: 12345678,
  prNumber: 7,
  headSha: 'a'.repeat(40),
};

describe('scanRequestSchema', () => {
  it('accepts a minimal valid body and defaults the collections', () => {
    const parsed = scanRequestSchema.safeParse(validBody);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.fileChanges).toEqual([]);
    expect(parsed.data.activePolicies).toEqual([]);
    expect(parsed.data.customIgnores).toEqual([]);
    expect(parsed.data.customPlaceholders).toEqual([]);
  });

  it('drops userId, so a caller cannot choose the audit-log actor', () => {
    const parsed = scanRequestSchema.safeParse({ ...validBody, userId: 'someone-else' });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).not.toHaveProperty('userId');
  });

  it('drops repositoryFullName, so a caller cannot aim the app at another repo', () => {
    const parsed = scanRequestSchema.safeParse({
      ...validBody,
      repositoryFullName: 'someone-else/their-repo',
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).not.toHaveProperty('repositoryFullName');
  });

  it('requires a non-empty repositoryId', () => {
    expect(scanRequestSchema.safeParse({ ...validBody, repositoryId: '' }).success).toBe(false);
    expect(
      scanRequestSchema.safeParse({ ...validBody, repositoryId: undefined }).success
    ).toBe(false);
  });

  it('requires a positive integer PR number', () => {
    expect(scanRequestSchema.safeParse({ ...validBody, prNumber: 0 }).success).toBe(false);
    expect(scanRequestSchema.safeParse({ ...validBody, prNumber: -3 }).success).toBe(false);
    expect(scanRequestSchema.safeParse({ ...validBody, prNumber: 1.5 }).success).toBe(false);
    expect(scanRequestSchema.safeParse({ ...validBody, prNumber: '7' }).success).toBe(false);
  });

  it('requires a head SHA', () => {
    expect(scanRequestSchema.safeParse({ ...validBody, headSha: '' }).success).toBe(false);
  });

  it('still accepts an installation id in either form', () => {
    expect(scanRequestSchema.safeParse({ ...validBody, installationId: '12345678' }).success).toBe(
      true
    );
  });
});

describe('loadOwnedRepository', () => {
  it('scopes the lookup to the session user', async () => {
    const store = repositoryStore({ id: 'repo-1', fullName: 'me/mine' });

    await loadOwnedRepository(store, 'repo-1', 'user-1');

    expect(store.findFirst).toHaveBeenCalledWith({
      where: { id: 'repo-1', userId: 'user-1' },
      select: { id: true, fullName: true },
    });
  });

  it('returns null when the repository belongs to someone else', async () => {
    // The scoping is in the `where`, so the store simply finds nothing.
    const store = repositoryStore(null);

    await expect(loadOwnedRepository(store, 'repo-1', 'user-2')).resolves.toBeNull();
  });

  it('does not query at all for an empty repository id or user id', async () => {
    const store = repositoryStore({ id: 'repo-1', fullName: 'me/mine' });

    await expect(loadOwnedRepository(store, '', 'user-1')).resolves.toBeNull();
    await expect(loadOwnedRepository(store, 'repo-1', '')).resolves.toBeNull();
    expect(store.findFirst).not.toHaveBeenCalled();
  });
});

describe('buildScanJobData', () => {
  const repository = { id: 'repo-1', fullName: 'me/mine' };

  it('takes the repository name from the owned row, not the request', () => {
    const parsed = scanRequestSchema.parse({
      ...validBody,
      repositoryFullName: 'attacker/target',
    } as never);

    const data = buildScanJobData({ body: parsed, repository, userId: 'user-1' });

    expect(data.repositoryFullName).toBe('me/mine');
    expect(data.repositoryId).toBe('repo-1');
  });

  it('takes the actor from the session, not the request', () => {
    const parsed = scanRequestSchema.parse({ ...validBody, userId: 'victim' } as never);

    const data = buildScanJobData({ body: parsed, repository, userId: 'user-1' });

    expect(data.userId).toBe('user-1');
  });

  it('carries the scan parameters through unchanged', () => {
    const parsed = scanRequestSchema.parse({
      ...validBody,
      fileChanges: [{ filename: 'a.ts', patch: '@@' }],
      customIgnores: ['docs/**'],
      customPlaceholders: ['REPLACE_ME'],
      activePolicies: [{ description: 'No hardcoded secrets', severity: 'HIGH' }],
    });

    const data = buildScanJobData({ body: parsed, repository, userId: 'user-1' });

    expect(data.prNumber).toBe(7);
    expect(data.headSha).toBe('a'.repeat(40));
    expect(data.installationId).toBe(12345678);
    expect(data.fileChanges).toEqual([{ filename: 'a.ts', patch: '@@' }]);
    expect(data.customIgnores).toEqual(['docs/**']);
    expect(data.customPlaceholders).toEqual(['REPLACE_ME']);
    expect(data.activePolicies).toHaveLength(1);
  });

  it('leaves scanJobId for enqueueScan to fill in', () => {
    const data = buildScanJobData({
      body: scanRequestSchema.parse(validBody),
      repository,
      userId: 'user-1',
    });

    expect(data.scanJobId).toBe('');
  });
});

describe('scanJobVisibility', () => {
  it('shows a job whose repository the caller owns', () => {
    expect(
      scanJobVisibility({ repositoryId: 'repo-1', repository: { userId: 'user-1' } }, 'user-1')
    ).toBe('visible');
  });

  it('hides a job belonging to another account', () => {
    expect(
      scanJobVisibility({ repositoryId: 'repo-1', repository: { userId: 'user-1' } }, 'user-2')
    ).toBe('not-found');
  });

  it('reports a missing job as not-found rather than distinguishing it', () => {
    // Same answer for "does not exist" and "is not yours", so the endpoint
    // cannot be used to test whether a job id is real.
    expect(scanJobVisibility(null, 'user-1')).toBe('not-found');
    expect(scanJobVisibility(undefined, 'user-1')).toBe('not-found');
  });

  it('hides a job with no repository, which has no owner to compare against', () => {
    expect(scanJobVisibility({ repositoryId: null, repository: null }, 'user-1')).toBe(
      'not-found'
    );
    expect(scanJobVisibility({ repositoryId: 'repo-1', repository: null }, 'user-1')).toBe(
      'not-found'
    );
  });

  it('never answers visible for an empty user id', () => {
    expect(
      scanJobVisibility({ repositoryId: 'repo-1', repository: { userId: '' } }, '')
    ).toBe('visible');
    expect(
      scanJobVisibility({ repositoryId: 'repo-1', repository: { userId: 'user-1' } }, '')
    ).toBe('not-found');
  });
});

describe('loadScanJobOwnership', () => {
  it('selects only the owner, not the job payload', async () => {
    const store = scanJobStore({ repositoryId: 'repo-1', repository: { userId: 'user-1' } });

    await loadScanJobOwnership(store, 'job-1');

    expect(store.findUnique).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      select: { repositoryId: true, repository: { select: { userId: true } } },
    });
  });

  it('does not query for an empty id', async () => {
    const store = scanJobStore(null);

    await expect(loadScanJobOwnership(store, '')).resolves.toBeNull();
    expect(store.findUnique).not.toHaveBeenCalled();
  });
});
