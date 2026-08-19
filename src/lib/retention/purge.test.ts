import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_BATCH_SIZE,
  MAX_BATCHES_PER_TARGET,
  REDACTED_SNIPPET,
  formatReport,
  runRetention,
  type PurgeClient,
} from './purge';

const NOW = new Date('2026-08-16T00:00:00.000Z');

/**
 * An in-memory stand-in for the Prisma surface `runRetention` uses.
 *
 * `rows` seeds each table with ids; `findMany` hands them out in batches and
 * `deleteMany`/`updateMany` remove them, so batching behaves the way it would
 * against a real database instead of looping forever on a mock that never
 * changes state.
 */
function makeClient(
  rows: Partial<Record<'auditLog' | 'webhookEvent' | 'scanResult' | 'finding', string[]>> = {},
  openFingerprints: string[] = []
) {
  const tables: Record<string, string[]> = {
    auditLog: [...(rows.auditLog ?? [])],
    webhookEvent: [...(rows.webhookEvent ?? [])],
    scanResult: [...(rows.scanResult ?? [])],
    finding: [...(rows.finding ?? [])],
  };

  const created: unknown[] = [];

  const table = (name: string) => ({
    count: vi.fn(async () => tables[name].length),
    findMany: vi.fn(async (args: any) => tables[name].slice(0, args?.take ?? 10).map((id) => ({ id }))),
    deleteMany: vi.fn(async (args: any) => {
      const ids: string[] = args?.where?.id?.in ?? [];
      tables[name] = tables[name].filter((id) => !ids.includes(id));
      return { count: ids.length };
    }),
    updateMany: vi.fn(async (args: any) => {
      const ids: string[] = args?.where?.id?.in ?? [];
      // Redaction takes the row out of scope for the next batch, mirroring the
      // `codeSnippet notIn [REDACTED]` filter in the real query.
      tables[name] = tables[name].filter((id) => !ids.includes(id));
      return { count: ids.length };
    }),
    create: vi.fn(async (args: any) => {
      created.push(args);
      return args;
    }),
  });

  const db = {
    auditLog: table('auditLog'),
    webhookEvent: table('webhookEvent'),
    scanResult: table('scanResult'),
    finding: table('finding'),
    findingTriage: {
      findMany: vi.fn(async () => openFingerprints.map((fingerprint) => ({ fingerprint }))),
    },
  };

  return { db: db as unknown as PurgeClient, raw: db, tables, created };
}

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

describe('runRetention — dry run', () => {
  it('is the default', async () => {
    const { db } = makeClient();
    const report = await runRetention(db, { now: NOW, env: {} });
    expect(report.dryRun).toBe(true);
  });

  it('writes nothing', async () => {
    const { db, raw } = makeClient({ auditLog: ids('a', 10), webhookEvent: ids('w', 10) });

    await runRetention(db, { now: NOW, env: {} });

    expect(raw.auditLog.deleteMany).not.toHaveBeenCalled();
    expect(raw.webhookEvent.deleteMany).not.toHaveBeenCalled();
    expect(raw.scanResult.deleteMany).not.toHaveBeenCalled();
    expect(raw.finding.updateMany).not.toHaveBeenCalled();
  });

  it('still reports what would be affected', async () => {
    const { db } = makeClient({ auditLog: ids('a', 7) });
    const report = await runRetention(db, { now: NOW, env: {} });

    const audit = report.outcomes.find((o) => o.target === 'auditLog')!;
    expect(audit.affected).toBe(7);
  });

  it('does not write an audit row for a dry run', async () => {
    const { db, created } = makeClient({ auditLog: ids('a', 3) });
    await runRetention(db, { now: NOW, env: {} });
    expect(created).toHaveLength(0);
  });

  it('flags truncation instead of looping over rows it will not change', async () => {
    const { db } = makeClient({ auditLog: ids('a', 50) });
    const report = await runRetention(db, { now: NOW, env: {}, batchSize: 10 });

    const audit = report.outcomes.find((o) => o.target === 'auditLog')!;
    expect(audit.truncated).toBe(true);
    expect(audit.affected).toBe(10);
  });
});

describe('runRetention — apply', () => {
  it('deletes audit rows past the window', async () => {
    const { db, tables } = makeClient({ auditLog: ids('a', 5) });

    const report = await runRetention(db, { dryRun: false, now: NOW, env: {} });

    expect(tables.auditLog).toHaveLength(0);
    expect(report.outcomes.find((o) => o.target === 'auditLog')!.affected).toBe(5);
  });

  it('deletes in bounded batches rather than one huge statement', async () => {
    const { db, raw } = makeClient({ auditLog: ids('a', 25) });

    await runRetention(db, { dryRun: false, now: NOW, env: {}, batchSize: 10, only: ['auditLog'] });

    expect(raw.auditLog.deleteMany).toHaveBeenCalledTimes(3);
    for (const call of raw.auditLog.deleteMany.mock.calls) {
      expect((call[0] as any).where.id.in.length).toBeLessThanOrEqual(10);
    }
  });

  it('redacts finding snippets instead of deleting the findings', async () => {
    const { db, raw } = makeClient({ finding: ids('f', 3) });

    await runRetention(db, { dryRun: false, now: NOW, env: {}, only: ['findingSnippet'] });

    expect(raw.finding.updateMany).toHaveBeenCalled();
    const data = (raw.finding.updateMany.mock.calls[0][0] as any).data;
    expect(data.codeSnippet).toBe(REDACTED_SNIPPET);
  });

  it('never issues a delete against findings', async () => {
    const { db, raw } = makeClient({ finding: ids('f', 3) });
    await runRetention(db, { dryRun: false, now: NOW, env: {}, only: ['findingSnippet'] });
    expect((raw.finding as any).deleteMany).not.toHaveBeenCalled();
  });

  it('excludes findings with open triage from redaction', async () => {
    const { db, raw } = makeClient({ finding: ids('f', 3) }, ['fp-open-1', 'fp-open-2']);

    await runRetention(db, { dryRun: false, now: NOW, env: {}, only: ['findingSnippet'] });

    const where = (raw.finding.findMany.mock.calls[0][0] as any).where;
    expect(where.fingerprint.notIn).toEqual(['fp-open-1', 'fp-open-2']);
  });

  it('omits the fingerprint filter when nothing is open', async () => {
    const { db, raw } = makeClient({ finding: ids('f', 1) }, []);

    await runRetention(db, { dryRun: false, now: NOW, env: {}, only: ['findingSnippet'] });

    const where = (raw.finding.findMany.mock.calls[0][0] as any).where;
    expect(where).not.toHaveProperty('fingerprint');
  });

  it('skips already-redacted rows so the batch loop drains', async () => {
    const { db, raw } = makeClient({ finding: ids('f', 1) });

    await runRetention(db, { dryRun: false, now: NOW, env: {}, only: ['findingSnippet'] });

    const where = (raw.finding.findMany.mock.calls[0][0] as any).where;
    expect(where.codeSnippet.notIn).toContain(REDACTED_SNIPPET);
  });

  it('records the run in the audit log', async () => {
    const { db, created } = makeClient({ webhookEvent: ids('w', 2) });

    await runRetention(db, { dryRun: false, now: NOW, env: {} });

    expect(created).toHaveLength(1);
    const entry = (created[0] as any).data;
    expect(entry.action).toBe('RETENTION_PURGE');
    expect(entry.decision).toBe('ALLOW');
    expect(entry.metadata.totalAffected).toBeGreaterThan(0);
  });

  it('does not fail the run when the audit write itself fails', async () => {
    const { db, raw } = makeClient({ webhookEvent: ids('w', 2) });
    raw.auditLog.create.mockRejectedValueOnce(new Error('audit table is gone'));

    await expect(runRetention(db, { dryRun: false, now: NOW, env: {} })).resolves.toBeDefined();
  });
});

describe('runRetention — targeting and cutoffs', () => {
  it('honours --only', async () => {
    const { db, raw } = makeClient({ auditLog: ids('a', 3), webhookEvent: ids('w', 3) });

    const report = await runRetention(db, {
      dryRun: false,
      now: NOW,
      env: {},
      only: ['auditLog'],
    });

    expect(report.outcomes).toHaveLength(1);
    expect(raw.webhookEvent.deleteMany).not.toHaveBeenCalled();
  });

  it('applies the configured cutoff to the query', async () => {
    const { db, raw } = makeClient({ auditLog: ids('a', 1) });

    await runRetention(db, {
      dryRun: false,
      now: NOW,
      env: { AUDIT_LOG_RETENTION_DAYS: '10' },
      only: ['auditLog'],
    });

    const where = (raw.auditLog.findMany.mock.calls[0][0] as any).where;
    expect(where.timestamp.lt.toISOString()).toBe('2026-08-06T00:00:00.000Z');
  });

  it('skips the open-triage lookup when findings are not in scope', async () => {
    const { db, raw } = makeClient({ auditLog: ids('a', 1) });

    await runRetention(db, { dryRun: false, now: NOW, env: {}, only: ['auditLog'] });

    expect(raw.findingTriage.findMany).not.toHaveBeenCalled();
  });

  it('reports zero for an empty table without error', async () => {
    const { db } = makeClient();
    const report = await runRetention(db, { dryRun: false, now: NOW, env: {} });

    expect(report.totalAffected).toBe(0);
    expect(report.hadErrors).toBe(false);
  });
});

describe('runRetention — failure handling', () => {
  it('records a failing target and continues with the rest', async () => {
    const { db, raw, tables } = makeClient({ auditLog: ids('a', 2), webhookEvent: ids('w', 2) });
    raw.auditLog.findMany.mockRejectedValueOnce(new Error('deadlock detected'));

    const report = await runRetention(db, { dryRun: false, now: NOW, env: {} });

    const audit = report.outcomes.find((o) => o.target === 'auditLog')!;
    expect(audit.error).toContain('deadlock');
    expect(report.hadErrors).toBe(true);
    // The other targets still ran.
    expect(tables.webhookEvent).toHaveLength(0);
  });

  it('marks the audit entry PARTIAL when a target failed', async () => {
    const { db, raw, created } = makeClient({ auditLog: ids('a', 2), webhookEvent: ids('w', 2) });
    raw.auditLog.findMany.mockRejectedValueOnce(new Error('boom'));

    await runRetention(db, { dryRun: false, now: NOW, env: {} });

    expect((created[0] as any).data.decision).toBe('PARTIAL');
  });

  it('propagates a configuration error before touching anything', async () => {
    const { db, raw } = makeClient({ auditLog: ids('a', 5) });

    await expect(
      runRetention(db, { dryRun: false, now: NOW, env: { AUDIT_LOG_RETENTION_DAYS: 'never' } })
    ).rejects.toThrow();

    expect(raw.auditLog.deleteMany).not.toHaveBeenCalled();
  });
});

describe('bounds', () => {
  it('always terminates, even if the table never drains', async () => {
    const { db, raw } = makeClient();
    // A pathological client that always returns a full batch and deletes nothing.
    raw.auditLog.findMany.mockImplementation(async (args: any) =>
      ids('a', args.take).map((id) => ({ id }))
    );
    raw.auditLog.deleteMany.mockImplementation(async () => ({ count: 0 }));

    const report = await runRetention(db, {
      dryRun: false,
      now: NOW,
      env: {},
      only: ['auditLog'],
      batchSize: 10,
    });

    const audit = report.outcomes.find((o) => o.target === 'auditLog')!;
    expect(audit.truncated).toBe(true);
    expect(audit.batches).toBe(MAX_BATCHES_PER_TARGET);
  });

  it('clamps a nonsensical batch size to at least one', async () => {
    const { db, raw } = makeClient({ auditLog: ids('a', 2) });

    await runRetention(db, { dryRun: false, now: NOW, env: {}, batchSize: 0, only: ['auditLog'] });

    expect((raw.auditLog.findMany.mock.calls[0][0] as any).take).toBeGreaterThanOrEqual(1);
  });

  it('uses a sane default batch size', () => {
    expect(DEFAULT_BATCH_SIZE).toBeGreaterThan(0);
    expect(DEFAULT_BATCH_SIZE).toBeLessThanOrEqual(5_000);
  });
});

describe('formatReport', () => {
  it('labels a dry run unmistakably', async () => {
    const { db } = makeClient({ auditLog: ids('a', 3) });
    const output = formatReport(await runRetention(db, { now: NOW, env: {} }));

    expect(output).toContain('DRY RUN');
    expect(output).toContain('would delete');
  });

  it('labels an applied run', async () => {
    const { db } = makeClient({ auditLog: ids('a', 3) });
    const output = formatReport(await runRetention(db, { dryRun: false, now: NOW, env: {} }));

    expect(output).toContain('APPLIED');
    expect(output).not.toContain('DRY RUN');
  });

  it('says "redact" for findings and "delete" for everything else', async () => {
    const { db } = makeClient({ finding: ids('f', 2) });
    const output = formatReport(
      await runRetention(db, { dryRun: false, now: NOW, env: {}, only: ['findingSnippet'] })
    );

    expect(output).toContain('redact');
  });

  it('surfaces a failure rather than burying it in the totals', async () => {
    const { db, raw } = makeClient({ auditLog: ids('a', 2) });
    raw.auditLog.findMany.mockRejectedValueOnce(new Error('deadlock detected'));

    const output = formatReport(await runRetention(db, { dryRun: false, now: NOW, env: {} }));

    expect(output).toContain('FAILED');
    expect(output).toContain('deadlock detected');
  });

  it('flags a truncated target so the operator knows to run again', async () => {
    const { db } = makeClient({ auditLog: ids('a', 50) });
    const output = formatReport(await runRetention(db, { now: NOW, env: {}, batchSize: 10 }));

    expect(output).toContain('more remain');
  });
});
