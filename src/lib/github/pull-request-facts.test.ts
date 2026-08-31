import { describe, it, expect } from 'vitest';
import {
  METADATA_ONLY_ACTIONS,
  SCANNABLE_ACTIONS,
  buildPullRequestFacts,
  classifyPullRequestAction,
  isMergedPayload,
  pullRequestUpdateData,
  resolveAuthorAvatarUrl,
  resolveAuthorLogin,
  resolvePullRequestState,
  resolvePullRequestTitle,
} from './pull-request-facts';

/** A payload shaped like the ones GitHub actually sends. */
const payload = (overrides: Record<string, unknown> = {}) => ({
  number: 42,
  title: 'Add rate limiting',
  state: 'open',
  user: { login: 'tokyo_coder', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
  ...overrides,
});

describe('classifyPullRequestAction', () => {
  it.each([...SCANNABLE_ACTIONS])('scans on %s', (action) => {
    expect(classifyPullRequestAction(action)).toBe('scan');
  });

  it.each([...METADATA_ONLY_ACTIONS])('records metadata only on %s', (action) => {
    expect(classifyPullRequestAction(action)).toBe('metadata');
  });

  it('routes closed to metadata rather than dropping it', () => {
    // The regression this whole change exists for: `closed` was not in the old
    // filter at all, so the one delivery that can report a merge was ignored.
    expect(classifyPullRequestAction('closed')).toBe('metadata');
  });

  it('ignores the actions GitHub sends that mean nothing to us', () => {
    for (const action of ['labeled', 'assigned', 'review_requested', 'unlabeled']) {
      expect(classifyPullRequestAction(action)).toBe('ignore');
    }
  });

  it('is case and whitespace insensitive', () => {
    expect(classifyPullRequestAction('  SYNCHRONIZE ')).toBe('scan');
    expect(classifyPullRequestAction('Closed')).toBe('metadata');
  });

  it('ignores a missing or non-string action', () => {
    expect(classifyPullRequestAction(undefined)).toBe('ignore');
    expect(classifyPullRequestAction(null)).toBe('ignore');
    expect(classifyPullRequestAction(7)).toBe('ignore');
  });
});

describe('isMergedPayload', () => {
  it('accepts the documented boolean', () => {
    expect(isMergedPayload(payload({ merged: true }))).toBe(true);
  });

  it('accepts a merged_at timestamp on its own', () => {
    // Some replayed and third-party deliveries carry the timestamp without the
    // boolean; requiring both would leave those recorded as merely closed.
    expect(isMergedPayload(payload({ merged_at: '2026-08-01T10:00:00Z' }))).toBe(true);
  });

  it('does not treat a null merged_at as a merge', () => {
    expect(isMergedPayload(payload({ merged: false, merged_at: null }))).toBe(false);
    expect(isMergedPayload(payload({ merged_at: '   ' }))).toBe(false);
  });

  it('is false for a payload that says nothing about merging', () => {
    expect(isMergedPayload(payload())).toBe(false);
    expect(isMergedPayload(null)).toBe(false);
    expect(isMergedPayload(undefined)).toBe(false);
  });
});

describe('resolvePullRequestState', () => {
  it('maps an open pull request to OPEN', () => {
    expect(resolvePullRequestState(payload({ state: 'open' }))).toBe('OPEN');
  });

  it('maps a closed-but-unmerged pull request to CLOSED', () => {
    expect(resolvePullRequestState(payload({ state: 'closed', merged: false }))).toBe('CLOSED');
  });

  it('maps a merged pull request to MERGED even though GitHub calls it closed', () => {
    // This is the bug in one line. GitHub never sends state: "merged", so the
    // old `normalizePrStateEnum(pull_request.state)` could only ever produce
    // CLOSED here — and PRState.MERGED was unreachable in the whole codebase.
    expect(resolvePullRequestState(payload({ state: 'closed', merged: true }))).toBe('MERGED');
  });

  it('prefers the merge signal over the state field', () => {
    expect(
      resolvePullRequestState(payload({ state: 'closed', merged_at: '2026-08-01T10:00:00Z' }))
    ).toBe('MERGED');
  });

  it('still understands an explicit MERGED state, for replayed rows', () => {
    expect(resolvePullRequestState(payload({ state: 'MERGED' }))).toBe('MERGED');
  });

  it('falls back to OPEN for a missing or unrecognised state', () => {
    // Never close a live pull request because a payload was malformed.
    expect(resolvePullRequestState(payload({ state: undefined }))).toBe('OPEN');
    expect(resolvePullRequestState(payload({ state: 'draft' }))).toBe('OPEN');
    expect(resolvePullRequestState(payload({ state: 99 }))).toBe('OPEN');
    expect(resolvePullRequestState(null)).toBe('OPEN');
  });
});

describe('resolveAuthorLogin', () => {
  it('reads the login from pull_request.user', () => {
    expect(resolveAuthorLogin(payload())).toBe('tokyo_coder');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveAuthorLogin(payload({ user: { login: '  denver_dev  ' } }))).toBe('denver_dev');
  });

  it('returns null when the payload names no user', () => {
    expect(resolveAuthorLogin(payload({ user: null }))).toBeNull();
    expect(resolveAuthorLogin(payload({ user: {} }))).toBeNull();
    expect(resolveAuthorLogin(payload({ user: { login: '   ' } }))).toBeNull();
    expect(resolveAuthorLogin(undefined)).toBeNull();
  });
});

describe('resolveAuthorAvatarUrl', () => {
  it('accepts an https avatar', () => {
    expect(resolveAuthorAvatarUrl(payload())).toBe(
      'https://avatars.githubusercontent.com/u/1?v=4'
    );
  });

  it('rejects a non-https scheme', () => {
    // The value is rendered as an <img src> on the public leaderboard. A valid
    // signature proves the body came from GitHub, not that every field in it is
    // safe to hand to a browser.
    for (const url of [
      'http://avatars.githubusercontent.com/u/1',
      'javascript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    ]) {
      expect(resolveAuthorAvatarUrl(payload({ user: { login: 'x', avatar_url: url } }))).toBeNull();
    }
  });

  it('rejects something that is not a URL at all', () => {
    expect(
      resolveAuthorAvatarUrl(payload({ user: { login: 'x', avatar_url: 'not a url' } }))
    ).toBeNull();
  });

  it('returns null when absent, so the leaderboard falls back to github.com/<login>.png', () => {
    expect(resolveAuthorAvatarUrl(payload({ user: { login: 'x' } }))).toBeNull();
  });
});

describe('resolvePullRequestTitle', () => {
  it('uses the payload title', () => {
    expect(resolvePullRequestTitle(payload())).toBe('Add rate limiting');
  });

  it('falls back to the pull request number', () => {
    expect(resolvePullRequestTitle(payload({ title: '' }))).toBe('PR #42');
    expect(resolvePullRequestTitle(payload({ title: undefined }))).toBe('PR #42');
  });

  it('has a last resort when there is no number either', () => {
    expect(resolvePullRequestTitle({})).toBe('Untitled pull request');
  });
});

describe('buildPullRequestFacts', () => {
  it('collects everything the stored row needs from a merge delivery', () => {
    expect(
      buildPullRequestFacts(
        payload({ state: 'closed', merged: true, merged_at: '2026-08-01T10:00:00Z' })
      )
    ).toEqual({
      title: 'Add rate limiting',
      state: 'MERGED',
      authorLogin: 'tokyo_coder',
      authorAvatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    });
  });

  it('degrades to nulls rather than throwing on a bare payload', () => {
    expect(buildPullRequestFacts({})).toEqual({
      title: 'Untitled pull request',
      state: 'OPEN',
      authorLogin: null,
      authorAvatarUrl: null,
    });
  });
});

describe('pullRequestUpdateData', () => {
  it('writes authorship so rows created before this change get backfilled', () => {
    // Every PullRequest row written by the old code has authorLogin = NULL, and
    // the leaderboard filters on `authorLogin: { not: null }`. Putting these in
    // `update` and not only in `create` is what makes those rows recoverable.
    expect(pullRequestUpdateData(buildPullRequestFacts(payload()))).toEqual({
      title: 'Add rate limiting',
      state: 'OPEN',
      authorLogin: 'tokyo_coder',
      authorAvatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    });
  });

  it('omits authorship the payload did not carry, rather than nulling it out', () => {
    const data = pullRequestUpdateData(buildPullRequestFacts(payload({ user: null })));

    expect(data).toEqual({ title: 'Add rate limiting', state: 'OPEN' });
    expect('authorLogin' in data).toBe(false);
    expect('authorAvatarUrl' in data).toBe(false);
  });

  it('omits only the avatar when the login is present but the avatar is not', () => {
    const data = pullRequestUpdateData(
      buildPullRequestFacts(payload({ user: { login: 'rio' } }))
    );

    expect(data).toEqual({ title: 'Add rate limiting', state: 'OPEN', authorLogin: 'rio' });
  });
});
