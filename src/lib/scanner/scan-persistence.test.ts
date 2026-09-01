import { describe, it, expect } from 'vitest';
import {
  InvalidInstallationIdError,
  ScanPersistenceError,
  checkRunConclusion,
  findingCreateInput,
  parseInstallationId,
  progressPercent,
  scanJobCompletion,
  scanResultCreateData,
  storedPolicyDecision,
  storedRiskScore,
  type EnrichedScanFinding,
} from './scan-persistence';

/** A finding with only the fields the scanner guarantees. */
function finding(overrides: Partial<EnrichedScanFinding> = {}): EnrichedScanFinding {
  return {
    type: 'Vulnerability',
    severity: 'HIGH',
    description: 'SQL built by string concatenation',
    fileLocation: 'src/db/query.ts',
    codeSnippet: 'db.query("SELECT * FROM t WHERE id = " + id)',
    ...overrides,
  };
}

describe('parseInstallationId', () => {
  it('passes a positive integer through', () => {
    expect(parseInstallationId(12345678)).toBe(12345678);
  });

  it('accepts the string form BullMQ round-trips', () => {
    expect(parseInstallationId('12345678')).toBe(12345678);
    expect(parseInstallationId('  12345678  ')).toBe(12345678);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['trailing junk', '123abc'],
    ['hex', '0x10'],
    ['exponent', '1e3'],
    ['negative', '-1'],
    ['decimal', '12.5'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseInstallationId(value)).toThrow(InvalidInstallationIdError);
  });

  it('rejects zero, which is what an unset environment variable coerces to', () => {
    expect(() => parseInstallationId(0)).toThrow(InvalidInstallationIdError);
    expect(() => parseInstallationId('0')).toThrow(InvalidInstallationIdError);
  });

  it('rejects a number too large to be exact', () => {
    expect(() => parseInstallationId(Number.MAX_SAFE_INTEGER + 2)).toThrow(
      InvalidInstallationIdError,
    );
  });

  it('names the offending value in the message without throwing on it', () => {
    expect(() => parseInstallationId('nope')).toThrow(/"nope"/);
  });
});

describe('storedPolicyDecision', () => {
  it('maps every verdict iq.evaluateFindings can return onto an enum member', () => {
    // These three strings are the complete range of `iq.evaluateFindings`. Two
    // of them were being written to a `PolicyDecision` column verbatim.
    expect(storedPolicyDecision('PASS')).toBe('PASS');
    expect(storedPolicyDecision('REVIEW REQUIRED')).toBe('REVIEW');
    expect(storedPolicyDecision('BLOCKED')).toBe('BLOCK');
  });

  it('falls back to REVIEW for anything unrecognised', () => {
    expect(storedPolicyDecision(undefined)).toBe('REVIEW');
    expect(storedPolicyDecision(null)).toBe('REVIEW');
    expect(storedPolicyDecision('something else')).toBe('REVIEW');
  });

  it('only ever answers with a PolicyDecision member', () => {
    const members = ['PASS', 'REVIEW', 'BLOCK'];
    for (const input of ['PASS', 'REVIEW REQUIRED', 'BLOCKED', '', 'x', 7, null]) {
      expect(members).toContain(storedPolicyDecision(input));
    }
  });
});

describe('checkRunConclusion', () => {
  it('reports the GitHub conclusion for each verdict', () => {
    expect(checkRunConclusion('PASS')).toBe('success');
    expect(checkRunConclusion('REVIEW REQUIRED')).toBe('action_required');
    expect(checkRunConclusion('BLOCKED')).toBe('failure');
  });

  it('agrees with the stored decision for every input', () => {
    const expected = { PASS: 'success', REVIEW: 'action_required', BLOCK: 'failure' } as const;

    for (const verdict of ['PASS', 'REVIEW REQUIRED', 'BLOCKED', 'nonsense']) {
      expect(checkRunConclusion(verdict)).toBe(expected[storedPolicyDecision(verdict)]);
    }
  });
});

describe('findingCreateInput', () => {
  it('converts the display label the scanner stores into a FindingType member', () => {
    expect(findingCreateInput(finding({ type: 'Secret' })).type).toBe('SECRET');
    expect(findingCreateInput(finding({ type: 'Vulnerability' })).type).toBe('VULNERABILITY');
    expect(findingCreateInput(finding({ type: 'Misconfig' })).type).toBe('MISCONFIG');
  });

  it('maps an unrecognised type to VULNERABILITY rather than emitting it', () => {
    expect(findingCreateInput(finding({ type: 'hallucinated_category' })).type).toBe(
      'VULNERABILITY',
    );
  });

  it('never emits NONE for severity, which is not a FindingSeverity member', () => {
    const row = findingCreateInput(finding({ severity: 'NONE' }));
    expect(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']).toContain(row.severity);
    expect(row.severity).not.toBe('NONE');
  });

  it('carries the enrichment the pipeline computed', () => {
    const row = findingCreateInput(
      finding({
        explanation: 'Concatenated input reaches the query.',
        remediation: 'Use a parameterised query.',
        promptInjectionSuspected: true,
      }),
    );

    expect(row.explanation).toBe('Concatenated input reaches the query.');
    expect(row.remediation).toBe('Use a parameterised query.');
    expect(row.promptInjectionSuspected).toBe(true);
  });

  it('stores nulls rather than undefined for absent enrichment', () => {
    const row = findingCreateInput(finding());

    expect(row.explanation).toBeNull();
    expect(row.remediation).toBeNull();
    expect(row.promptInjectionSuspected).toBe(false);
  });

  it('stores explicit nulls for line numbers the model did not report', () => {
    const row = findingCreateInput(finding());

    expect(row.lineStart).toBeNull();
    expect(row.lineEnd).toBeNull();
  });

  it('keeps line numbers that are present, including zero', () => {
    const row = findingCreateInput(finding({ lineStart: 0, lineEnd: 12 }));

    expect(row.lineStart).toBe(0);
    expect(row.lineEnd).toBe(12);
  });

  it('defaults the fingerprint to the empty string the column expects', () => {
    expect(findingCreateInput(finding()).fingerprint).toBe('');
    expect(findingCreateInput(finding({ fingerprint: 'abc' })).fingerprint).toBe('abc');
  });

  it('turns an empty snippet into null', () => {
    expect(findingCreateInput(finding({ codeSnippet: '' })).codeSnippet).toBeNull();
  });
});

describe('storedRiskScore', () => {
  it('sums the severity weights', () => {
    const score = storedRiskScore([
      finding({ severity: 'CRITICAL' }),
      finding({ severity: 'LOW' }),
    ]);

    expect(score).toBeGreaterThan(0);
    expect(Number.isInteger(score)).toBe(true);
  });

  it('is zero for no findings', () => {
    expect(storedRiskScore([])).toBe(0);
  });

  it('always produces an integer, because the column is an Int', () => {
    const score = storedRiskScore([
      finding({ severity: 'CRITICAL' }),
      finding({ severity: 'HIGH' }),
      finding({ severity: 'MEDIUM' }),
      finding({ severity: 'LOW' }),
      finding({ severity: 'NONE' }),
    ]);

    expect(Number.isInteger(score)).toBe(true);
  });
});

describe('scanResultCreateData', () => {
  const active = [finding({ severity: 'CRITICAL', fingerprint: 'fp-active' })];
  const suppressed = [finding({ severity: 'CRITICAL', fingerprint: 'fp-dismissed' })];

  it('writes a PolicyDecision member, not the scanner verdict', () => {
    const data = scanResultCreateData({
      pullRequestId: 'pr-1',
      decision: 'BLOCKED',
      scoredFindings: active,
      findingsToPersist: active,
    });

    expect(data.policyDecision).toBe('BLOCK');
  });

  it('stores suppressed findings but does not score them', () => {
    const data = scanResultCreateData({
      pullRequestId: 'pr-1',
      decision: 'REVIEW REQUIRED',
      scoredFindings: active,
      findingsToPersist: [...active, ...suppressed],
    });

    expect(data.findings.create).toHaveLength(2);
    expect(data.riskScore).toBe(storedRiskScore(active));
    expect(data.riskScore).toBeLessThan(storedRiskScore([...active, ...suppressed]));
  });

  it('carries the pull request id through unchanged', () => {
    const data = scanResultCreateData({
      pullRequestId: 'pr-42',
      decision: 'PASS',
      scoredFindings: [],
      findingsToPersist: [],
    });

    expect(data).toEqual({
      pullRequestId: 'pr-42',
      riskScore: 0,
      policyDecision: 'PASS',
      findings: { create: [] },
    });
  });
});

describe('scanJobCompletion', () => {
  const completedAt = new Date('2026-08-30T10:00:00.000Z');

  it('normalises the decision before it reaches the enum column', () => {
    const update = scanJobCompletion(
      {
        scannedFiles: 12,
        vulnerabilitiesFound: 3,
        riskScore: 40,
        policyDecision: 'REVIEW REQUIRED',
      },
      completedAt,
    );

    expect(update).toEqual({
      status: 'COMPLETED',
      scannedFiles: 12,
      vulnerabilitiesFound: 3,
      riskScore: 40,
      policyDecision: 'REVIEW',
      completedAt,
    });
  });

  it('completes a blocked scan rather than failing it', () => {
    const update = scanJobCompletion(
      { scannedFiles: 1, vulnerabilitiesFound: 1, riskScore: 10, policyDecision: 'BLOCKED' },
      completedAt,
    );

    expect(update.status).toBe('COMPLETED');
    expect(update.policyDecision).toBe('BLOCK');
  });

  it('rounds a fractional risk score for the Int column', () => {
    const update = scanJobCompletion(
      { scannedFiles: 1, vulnerabilitiesFound: 1, riskScore: 10.6, policyDecision: 'PASS' },
      completedAt,
    );

    expect(update.riskScore).toBe(11);
  });

  it('defaults completedAt to now', () => {
    const before = Date.now();
    const update = scanJobCompletion({
      scannedFiles: 0,
      vulnerabilitiesFound: 0,
      riskScore: 0,
      policyDecision: 'PASS',
    });

    expect(update.completedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('progressPercent', () => {
  it('reports a whole percentage', () => {
    expect(progressPercent(5, 20)).toBe(25);
    expect(progressPercent(1, 3)).toBe(33);
  });

  it('is 0 rather than NaN for an empty file set', () => {
    expect(progressPercent(0, 0)).toBe(0);
  });

  it('clamps an overshooting chunk to 100', () => {
    // The engine advances by a fixed CHUNK_SIZE, so the last chunk of a partial
    // batch can put `scannedFiles` past `totalFiles`.
    expect(progressPercent(30, 22)).toBe(100);
  });

  it('never returns a negative or non-finite value', () => {
    expect(progressPercent(-5, 10)).toBe(0);
    expect(progressPercent(Number.NaN, 10)).toBe(0);
    expect(progressPercent(5, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('ScanPersistenceError', () => {
  it('says the scan succeeded and the write did not', () => {
    const error = new ScanPersistenceError('Invalid value for argument `policyDecision`');

    expect(error.name).toBe('ScanPersistenceError');
    expect(error.message).toContain('could not be persisted');
    expect(error.message).toContain('policyDecision');
  });
});
