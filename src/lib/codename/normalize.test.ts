import { describe, it, expect } from 'vitest';
import {
  MAX_CODENAME_LENGTH,
  MIN_CODENAME_LENGTH,
  codenameKey,
  codenameTakenError,
  isCodenameConflict,
  isReservedCodename,
  normalizeCodename,
  reservedCodenames,
  validateCodename,
} from './normalize';

describe('normalizeCodename', () => {
  it('title-cases a single word', () => {
    expect(normalizeCodename('tokyo')).toBe('Tokyo');
    expect(normalizeCodename('TOKYO')).toBe('Tokyo');
    expect(normalizeCodename('ToKyO')).toBe('Tokyo');
  });

  it('title-cases every word, not just the first', () => {
    // The old rule only normalised a single alphabetic word, so `Tokyo Two` and
    // `TOKYO TWO` were two different rows as far as the unique index was
    // concerned.
    expect(normalizeCodename('tokyo two')).toBe('Tokyo Two');
    expect(normalizeCodename('TOKYO TWO')).toBe('Tokyo Two');
    expect(normalizeCodename('tOkYo TwO')).toBe('Tokyo Two');
  });

  it('title-cases alphabetic runs inside a mixed word', () => {
    // `agent-007` and `AGENT-007` must land on the same canonical form; a
    // per-word rule would have left both alone.
    expect(normalizeCodename('agent-007')).toBe('Agent-007');
    expect(normalizeCodename('AGENT-007')).toBe('Agent-007');
    expect(normalizeCodename('tokyo_two')).toBe('Tokyo_Two');
    expect(normalizeCodename('OSLO-2')).toBe('Oslo-2');
  });

  it('collapses internal whitespace', () => {
    // `Tokyo  Two` with two spaces was a distinct codename from `Tokyo Two`,
    // which is exactly the shape an impersonation attempt takes on a public
    // leaderboard.
    expect(normalizeCodename('Tokyo  Two')).toBe('Tokyo Two');
    expect(normalizeCodename('Tokyo   Two')).toBe('Tokyo Two');
    expect(normalizeCodename('  Tokyo Two  ')).toBe('Tokyo Two');
  });

  it('is idempotent', () => {
    // Anything else means the canonical form is not canonical.
    for (const value of ['tokyo', 'TOKYO TWO', 'agent-007', '  a  b  ']) {
      const once = normalizeCodename(value);
      expect(normalizeCodename(once)).toBe(once);
    }
  });

  it('returns an empty string for non-string input', () => {
    expect(normalizeCodename(null)).toBe('');
    expect(normalizeCodename(undefined)).toBe('');
    expect(normalizeCodename(42 as unknown as string)).toBe('');
  });

  it('leaves digits alone', () => {
    expect(normalizeCodename('007')).toBe('007');
  });
});

describe('codenameKey', () => {
  it('collapses separators and case onto one reservation', () => {
    expect(codenameKey('Tokyo-Two')).toBe('tokyotwo');
    expect(codenameKey('tokyo two')).toBe('tokyotwo');
    expect(codenameKey('TOKYO_TWO')).toBe('tokyotwo');
  });

  it('distinguishes genuinely different names', () => {
    expect(codenameKey('Tokyo')).not.toBe(codenameKey('Berlin'));
  });
});

describe('isReservedCodename', () => {
  it.each(['SecureFlow', 'secure flow', 'SECURE_FLOW', 'Admin', 'The Professor', 'system'])(
    'reserves %s',
    (value) => {
      expect(isReservedCodename(value)).toBe(true);
    }
  );

  it('does not reserve the actual city names', () => {
    // The whole point of the ceremony is that these are claimable.
    for (const city of ['Tokyo', 'Berlin', 'Nairobi', 'Denver', 'Oslo']) {
      expect(isReservedCodename(city)).toBe(false);
    }
  });

  it('exposes the list for display', () => {
    expect(reservedCodenames()).toContain('SecureFlow');
    expect(reservedCodenames().length).toBeGreaterThan(5);
  });

  it('hands back a copy, so a caller cannot edit the reservations', () => {
    const list = reservedCodenames();
    list.push('Tokyo');
    expect(reservedCodenames()).not.toContain('Tokyo');
  });
});

describe('validateCodename', () => {
  it('accepts and canonicalises a good name', () => {
    expect(validateCodename('tokyo')).toEqual({ ok: true, codename: 'Tokyo' });
    expect(validateCodename('  TOKYO two ')).toEqual({ ok: true, codename: 'Tokyo Two' });
  });

  it('rejects an empty or whitespace-only name', () => {
    for (const value of ['', '   ', null, undefined]) {
      const result = validateCodename(value);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain('cannot be empty');
    }
  });

  it('enforces the length bounds', () => {
    const short = validateCodename('A');
    expect(short.ok === false && short.error).toContain('between 2 and 30 characters');

    const long = validateCodename('A'.repeat(MAX_CODENAME_LENGTH + 1));
    expect(long.ok === false && long.error).toContain('between 2 and 30 characters');

    expect(validateCodename('A'.repeat(MIN_CODENAME_LENGTH)).ok).toBe(true);
    expect(validateCodename('A'.repeat(MAX_CODENAME_LENGTH)).ok).toBe(true);
  });

  it('rejects disallowed characters', () => {
    const result = validateCodename('Tokyo<script>');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('can only contain letters, numbers');
  });

  it('rejects a name with no letters or digits at all', () => {
    // `- -` passes the character check but is not a name.
    const result = validateCodename('- -');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('at least one letter or number');
  });

  it('rejects a reserved name', () => {
    const result = validateCodename('secureflow');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('reserved');
  });

  it('rejects a reserved name however it is spelled', () => {
    for (const value of ['ADMIN', 'ad-min', 'Ad_Min']) {
      expect(validateCodename(value).ok).toBe(false);
    }
  });

  it('measures length before normalising, so the message matches what was typed', () => {
    // Normalisation only collapses whitespace, so it can never push a valid
    // value over the ceiling — but checking after would let a 31-character
    // input with a double space slip through as 30.
    const value = `${'A'.repeat(MAX_CODENAME_LENGTH - 1)}  B`;
    expect(validateCodename(value).ok).toBe(false);
  });
});

describe('codenameTakenError', () => {
  it('names the codename and suggests a way forward', () => {
    const message = codenameTakenError('Tokyo');
    expect(message).toContain('Tokyo');
    expect(message).toContain('already taken');
  });
});

describe('isCodenameConflict', () => {
  it('recognises a P2002 on codename', () => {
    expect(isCodenameConflict({ code: 'P2002', meta: { target: ['codename'] } })).toBe(true);
  });

  it('recognises the string form some connectors report', () => {
    expect(isCodenameConflict({ code: 'P2002', meta: { target: 'User_codename_key' } })).toBe(true);
  });

  it('treats a P2002 with no target as a codename conflict', () => {
    // The only unique constraint this update can violate is `codename`.
    expect(isCodenameConflict({ code: 'P2002' })).toBe(true);
    expect(isCodenameConflict({ code: 'P2002', meta: {} })).toBe(true);
  });

  it('does not claim an unrelated constraint', () => {
    expect(isCodenameConflict({ code: 'P2002', meta: { target: ['email'] } })).toBe(false);
  });

  it('does not claim an unrelated error', () => {
    expect(isCodenameConflict({ code: 'P2025' })).toBe(false);
    expect(isCodenameConflict(new Error('connection lost'))).toBe(false);
    expect(isCodenameConflict(null)).toBe(false);
    expect(isCodenameConflict('P2002')).toBe(false);
  });
});
