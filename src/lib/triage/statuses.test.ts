import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SUPPRESSED_STATUSES,
  TRIAGE_STATUSES,
  isSuppressedStatus,
  isTriageStatus,
} from './statuses';
import { DISMISSED_STATUSES, FINDING_STATUSES } from '@/lib/findings/query';

/**
 * The triage vocabulary (#689).
 *
 * Four call sites each carried their own copy of these strings. The comment on
 * `DISMISSED_STATUSES` said a test asserted they agreed — which they did, and
 * which is exactly the workaround this module removes.
 */
describe('TRIAGE_STATUSES matches the FindingTriageStatus enum', () => {
  it('holds exactly the members the database declares', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf-8');
    const match = schema.match(/enum\s+FindingTriageStatus\s*\{([^}]*)\}/);

    expect(match, 'enum FindingTriageStatus not found in prisma/schema.prisma').toBeTruthy();

    const members = (match![1].match(/[A-Z_][A-Z0-9_]*/g) ?? []).filter(Boolean);
    expect([...TRIAGE_STATUSES].sort()).toEqual(members.sort());
  });

  it('treats OPEN as a member even though it is the absence of a row', () => {
    expect(TRIAGE_STATUSES).toContain('OPEN');
  });
});

describe('SUPPRESSED_STATUSES', () => {
  it('is the two statuses that take a finding out of enforcement', () => {
    expect([...SUPPRESSED_STATUSES]).toEqual(['FALSE_POSITIVE', 'IGNORED']);
  });

  it('does not include RESOLVED', () => {
    // A resolved finding was real and was fixed, so it still counts toward the
    // author's history on the leaderboard.
    expect(SUPPRESSED_STATUSES).not.toContain('RESOLVED' as never);
  });

  it('is a subset of the full vocabulary', () => {
    for (const status of SUPPRESSED_STATUSES) {
      expect(TRIAGE_STATUSES).toContain(status);
    }
  });
});

describe('the duplicated copies now resolve to this one', () => {
  it('findings/query.ts re-exports the same list', () => {
    // Was a hand-written literal kept in sync by assertion.
    expect([...FINDING_STATUSES]).toEqual([...TRIAGE_STATUSES]);
    expect([...DISMISSED_STATUSES]).toEqual([...SUPPRESSED_STATUSES]);
  });

  it('is the identical array, not merely an equal one', () => {
    // The stronger property: they cannot drift, because there is nothing to drift.
    expect(FINDING_STATUSES).toBe(TRIAGE_STATUSES);
    expect(DISMISSED_STATUSES).toBe(SUPPRESSED_STATUSES);
  });
});

describe('isSuppressedStatus', () => {
  it('accepts the suppressed statuses', () => {
    expect(isSuppressedStatus('FALSE_POSITIVE')).toBe(true);
    expect(isSuppressedStatus('IGNORED')).toBe(true);
  });

  it('rejects the ones that stay in enforcement', () => {
    expect(isSuppressedStatus('OPEN')).toBe(false);
    expect(isSuppressedStatus('RESOLVED')).toBe(false);
  });

  it('is case sensitive, matching the enum', () => {
    expect(isSuppressedStatus('ignored')).toBe(false);
  });

  it('rejects non-strings without throwing', () => {
    expect(isSuppressedStatus(null)).toBe(false);
    expect(isSuppressedStatus(undefined)).toBe(false);
    expect(isSuppressedStatus(0)).toBe(false);
    expect(isSuppressedStatus({ status: 'IGNORED' })).toBe(false);
  });
});

describe('isTriageStatus', () => {
  it.each(TRIAGE_STATUSES)('accepts %s', (status) => {
    expect(isTriageStatus(status)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isTriageStatus('DISMISSED')).toBe(false);
    expect(isTriageStatus('')).toBe(false);
    expect(isTriageStatus(null)).toBe(false);
  });
});
