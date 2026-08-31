import { describe, it, expect, vi } from 'vitest';
import {
  MissingPullRequestIdError,
  parsePullRequestId,
  pullRequestCreateData,
  resolvePullRequestRecord,
  splitRepositoryFullName,
  type PullRequestStore,
} from './pull-request-record';
import { buildPullRequestFacts } from '@/lib/github/pull-request-facts';

/** A store that finds nothing and records what it was asked to write. */
function stubStore(existing: { id: string } | null = null) {
  const findFirst = vi.fn().mockResolvedValue(existing);
  const upsert = vi.fn().mockResolvedValue({ id: 'pr-row' });

  return { findFirst, upsert } as unknown as PullRequestStore & {
    findFirst: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
}

const githubPullRequest = {
  id: 9876543210,
  number: 7,
  title: 'Add rate limiting',
  state: 'open',
  user: { login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
};

describe('splitRepositoryFullName', () => {
  it('splits owner/repo', () => {
    expect(splitRepositoryFullName('GauravKarakoti/SecureFlow')).toEqual({
      owner: 'GauravKarakoti',
      repo: 'SecureFlow',
    });
  });

  it('trims surrounding whitespace on each half', () => {
    expect(splitRepositoryFullName(' owner / repo ')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it.each([
    ['a bare name', 'SecureFlow'],
    ['three segments', 'a/b/c'],
    ['a missing owner', '/repo'],
    ['a missing repo', 'owner/'],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('rejects %s', (_label, value) => {
    // The old `const [owner, repo] = fullName.split('/')` silently produced
    // `repo === undefined`, which reached Octokit as the string "undefined".
    expect(() => splitRepositoryFullName(value)).toThrow(/owner\/repo/);
  });

  it('rejects a non-string', () => {
    expect(() => splitRepositoryFullName(null as never)).toThrow(/owner\/repo/);
  });
});

describe('parsePullRequestId', () => {
  it('accepts the JSON number the REST API returns', () => {
    expect(parsePullRequestId(9876543210)).toBe(BigInt(9876543210));
  });

  it('accepts a numeric string, which is what a JSON round trip can leave', () => {
    expect(parsePullRequestId('9876543210')).toBe(BigInt('9876543210'));
    expect(parsePullRequestId(' 42 ')).toBe(BigInt(42));
  });

  it.each([
    ['zero', 0],
    ['zero as a string', '0'],
    ['negative', -5],
    ['fractional', 1.5],
    ['non-numeric', 'abc'],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('returns null for %s', (_label, value) => {
    expect(parsePullRequestId(value)).toBeNull();
  });
});

describe('pullRequestCreateData', () => {
  it('writes prNumber, not number, and carries no headSha', () => {
    const data = pullRequestCreateData({
      githubId: BigInt(1),
      prNumber: 7,
      repositoryId: 'repo-1',
      facts: buildPullRequestFacts(githubPullRequest),
    });

    expect(data).toHaveProperty('prNumber', 7);
    expect(data).not.toHaveProperty('number');
    expect(data).not.toHaveProperty('headSha');
  });

  it('records the author the leaderboard queries by', () => {
    const data = pullRequestCreateData({
      githubId: BigInt(1),
      prNumber: 7,
      repositoryId: 'repo-1',
      facts: buildPullRequestFacts(githubPullRequest),
    });

    expect(data.authorLogin).toBe('octocat');
    expect(data.authorAvatarUrl).toBe('https://avatars.githubusercontent.com/u/1?v=4');
  });

  it('leaves status to the column default', () => {
    const data = pullRequestCreateData({
      githubId: BigInt(1),
      prNumber: 7,
      repositoryId: 'repo-1',
      facts: buildPullRequestFacts(githubPullRequest),
    });

    expect(data).not.toHaveProperty('status');
  });
});

describe('resolvePullRequestRecord', () => {
  const baseArgs = {
    repositoryId: 'repo-1',
    repositoryFullName: 'GauravKarakoti/SecureFlow',
    prNumber: 7,
  };

  it('returns the existing row without calling GitHub', async () => {
    const store = stubStore({ id: 'existing-row' });
    const fetchPullRequest = vi.fn();

    const row = await resolvePullRequestRecord({ store, fetchPullRequest, ...baseArgs });

    expect(row).toEqual({ id: 'existing-row' });
    expect(fetchPullRequest).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('looks the row up by prNumber', async () => {
    const store = stubStore({ id: 'existing-row' });

    await resolvePullRequestRecord({ store, fetchPullRequest: vi.fn(), ...baseArgs });

    expect(store.findFirst).toHaveBeenCalledWith({
      where: { repositoryId: 'repo-1', prNumber: 7 },
      select: { id: true },
    });
  });

  it('fetches the real GitHub id instead of writing BigInt(0)', async () => {
    const store = stubStore(null);
    const fetchPullRequest = vi.fn().mockResolvedValue({ data: githubPullRequest });

    await resolvePullRequestRecord({ store, fetchPullRequest, ...baseArgs });

    expect(fetchPullRequest).toHaveBeenCalledWith({
      owner: 'GauravKarakoti',
      repo: 'SecureFlow',
      pull_number: 7,
    });

    const [call] = store.upsert.mock.calls;
    expect(call[0].where).toEqual({ githubId: BigInt(9876543210) });
    expect(call[0].create.githubId).toBe(BigInt(9876543210));
  });

  it('upserts rather than creates, so a concurrent scan does not collide', async () => {
    const store = stubStore(null);
    const fetchPullRequest = vi.fn().mockResolvedValue({ data: githubPullRequest });

    await resolvePullRequestRecord({ store, fetchPullRequest, ...baseArgs });

    expect(store.upsert).toHaveBeenCalledTimes(1);
    const [call] = store.upsert.mock.calls;
    expect(call[0].update).toMatchObject({ repositoryId: 'repo-1', prNumber: 7 });
  });

  it('stores the title and state GitHub reported', async () => {
    const store = stubStore(null);
    const fetchPullRequest = vi.fn().mockResolvedValue({ data: githubPullRequest });

    await resolvePullRequestRecord({ store, fetchPullRequest, ...baseArgs });

    const [call] = store.upsert.mock.calls;
    expect(call[0].create.title).toBe('Add rate limiting');
    expect(call[0].create.state).toBe('OPEN');
  });

  it('records a merged pull request as MERGED', async () => {
    const store = stubStore(null);
    const fetchPullRequest = vi.fn().mockResolvedValue({
      data: { ...githubPullRequest, state: 'closed', merged: true },
    });

    await resolvePullRequestRecord({ store, fetchPullRequest, ...baseArgs });

    const [call] = store.upsert.mock.calls;
    expect(call[0].create.state).toBe('MERGED');
  });

  it('falls back to "PR #n" when GitHub reports no title', async () => {
    const store = stubStore(null);
    const fetchPullRequest = vi
      .fn()
      .mockResolvedValue({ data: { id: 5, user: { login: 'x' } } });

    await resolvePullRequestRecord({ store, fetchPullRequest, ...baseArgs });

    const [call] = store.upsert.mock.calls;
    expect(call[0].create.title).toBe('PR #7');
  });

  it('throws rather than inventing an id when GitHub returns none', async () => {
    const store = stubStore(null);
    const fetchPullRequest = vi.fn().mockResolvedValue({ data: { title: 'no id here' } });

    await expect(
      resolvePullRequestRecord({ store, fetchPullRequest, ...baseArgs }),
    ).rejects.toBeInstanceOf(MissingPullRequestIdError);

    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('throws when GitHub returns no body at all', async () => {
    const store = stubStore(null);
    const fetchPullRequest = vi.fn().mockResolvedValue({ data: null });

    await expect(
      resolvePullRequestRecord({ store, fetchPullRequest, ...baseArgs }),
    ).rejects.toBeInstanceOf(MissingPullRequestIdError);
  });

  it('names the pull request in the error', async () => {
    const store = stubStore(null);
    const fetchPullRequest = vi.fn().mockResolvedValue({ data: {} });

    await expect(
      resolvePullRequestRecord({ store, fetchPullRequest, ...baseArgs }),
    ).rejects.toThrow('GauravKarakoti/SecureFlow#7');
  });

  it('rejects a malformed repository name before calling GitHub', async () => {
    const store = stubStore(null);
    const fetchPullRequest = vi.fn();

    await expect(
      resolvePullRequestRecord({
        store,
        fetchPullRequest,
        ...baseArgs,
        repositoryFullName: 'not-a-full-name',
      }),
    ).rejects.toThrow(/owner\/repo/);

    expect(fetchPullRequest).not.toHaveBeenCalled();
  });
});
