import { describe, it, expect } from 'vitest';
import {
  parseSyncTarget,
  singleRepositorySyncResponse,
  type SyncedRepository,
} from './repo-sync-request';

const repository: SyncedRepository = {
  id: 'repo-1',
  fullName: 'me/mine',
  owner: 'me',
  isActive: true,
};

describe('parseSyncTarget', () => {
  it('treats an absent body as a full sync', () => {
    expect(parseSyncTarget(null)).toEqual({ ok: true, repositoryId: null });
    expect(parseSyncTarget(undefined)).toEqual({ ok: true, repositoryId: null });
  });

  it('treats an object without repositoryId as a full sync', () => {
    expect(parseSyncTarget({})).toEqual({ ok: true, repositoryId: null });
    expect(parseSyncTarget({ repositoryId: null })).toEqual({ ok: true, repositoryId: null });
    expect(parseSyncTarget({ other: 'field' })).toEqual({ ok: true, repositoryId: null });
  });

  it('reads a named repository', () => {
    expect(parseSyncTarget({ repositoryId: 'repo-1' })).toEqual({
      ok: true,
      repositoryId: 'repo-1',
    });
  });

  it('trims the id', () => {
    expect(parseSyncTarget({ repositoryId: '  repo-1  ' })).toEqual({
      ok: true,
      repositoryId: 'repo-1',
    });
  });

  it('rejects an empty repositoryId rather than falling through to a full sync', () => {
    // The old branch was entered on truthiness, so `""` silently ran the full
    // sync while `{}` ran the fabricated one. Three ways of getting the field
    // wrong produced three different behaviours.
    expect(parseSyncTarget({ repositoryId: '' })).toEqual({
      ok: false,
      message: '`repositoryId` must not be empty',
    });
    expect(parseSyncTarget({ repositoryId: '   ' }).ok).toBe(false);
  });

  it('rejects a non-string repositoryId', () => {
    expect(parseSyncTarget({ repositoryId: 42 }).ok).toBe(false);
    expect(parseSyncTarget({ repositoryId: {} }).ok).toBe(false);
    expect(parseSyncTarget({ repositoryId: ['repo-1'] }).ok).toBe(false);
    expect(parseSyncTarget({ repositoryId: true }).ok).toBe(false);
  });

  it('rejects a body that is not an object', () => {
    expect(parseSyncTarget('repo-1').ok).toBe(false);
    expect(parseSyncTarget(7).ok).toBe(false);
    expect(parseSyncTarget([]).ok).toBe(false);
  });

  it('says what was wrong', () => {
    const result = parseSyncTarget({ repositoryId: 42 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('repositoryId');
  });
});

describe('singleRepositorySyncResponse', () => {
  it('reports COMPLETED only when a sync actually ran', () => {
    const response = singleRepositorySyncResponse(repository, {
      synced: 3,
      hasInstallation: true,
    });

    expect(response.status).toBe('COMPLETED');
    expect(response.success).toBe(true);
  });

  it('does not claim success when there is no installation', () => {
    // The fabricated branch answered `success: true, status: "COMPLETED"` for
    // every input, including an account with no GitHub App installed at all.
    const response = singleRepositorySyncResponse(repository, {
      synced: 0,
      hasInstallation: false,
    });

    expect(response.status).toBe('NO_INSTALLATION');
    expect(response.success).toBe(false);
  });

  it('does not claim success when the sync reported an error', () => {
    const response = singleRepositorySyncResponse(repository, {
      synced: 0,
      hasInstallation: true,
      error: 'Failed to synchronize repositories',
    });

    expect(response.status).toBe('FAILED');
    expect(response.success).toBe(false);
    expect(response.error).toBe('Failed to synchronize repositories');
  });

  it('omits the error field entirely on the success path', () => {
    const response = singleRepositorySyncResponse(repository, {
      synced: 1,
      hasInstallation: true,
    });

    expect(response).not.toHaveProperty('error');
  });

  it('carries the repository the caller asked about', () => {
    const response = singleRepositorySyncResponse(repository, {
      synced: 1,
      hasInstallation: true,
    });

    expect(response.repository).toEqual({
      id: 'repo-1',
      fullName: 'me/mine',
      owner: 'me',
      isActive: true,
    });
  });

  it('defaults the optional counters to zero rather than undefined', () => {
    const response = singleRepositorySyncResponse(repository, {
      synced: 2,
      hasInstallation: true,
    });

    expect(response.skipped).toBe(0);
    expect(response.failed).toBe(0);
  });

  it('reports the skipped and failed counts the run produced', () => {
    const response = singleRepositorySyncResponse(repository, {
      synced: 2,
      hasInstallation: true,
      skipped: 1,
      failed: 3,
    });

    expect(response.skipped).toBe(1);
    expect(response.failed).toBe(3);
  });

  it('never reports a fabricated file count', () => {
    const response = singleRepositorySyncResponse(repository, {
      synced: 1,
      hasInstallation: true,
    });

    expect(response).not.toHaveProperty('synchronizedFilesCount');
    expect(response).not.toHaveProperty('batchesProcessed');
  });
});
