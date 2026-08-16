import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  QUEUE_DEPTH_DEGRADED_THRESHOLD,
  databaseProbe,
  queueProbe,
  redisProbe,
  runCheck,
  statusCodeFor,
  summarize,
  withTimeout,
  type CheckResult,
} from './checks';

const result = (name: string, status: CheckResult['status']): CheckResult => ({
  name,
  status,
  durationMs: 1,
});

describe('withTimeout', () => {
  it('resolves with the probe result when it finishes in time', async () => {
    await expect(withTimeout(async () => 'done', 1000)).resolves.toBe('done');
  });

  it('resolves with the timeout sentinel when the probe hangs', async () => {
    const outcome = await withTimeout(() => new Promise(() => {}), 10);
    expect(outcome).not.toBe('done');
    expect(typeof outcome).toBe('symbol');
  });

  it('propagates a rejection rather than swallowing it', async () => {
    await expect(withTimeout(async () => { throw new Error('boom'); }, 1000)).rejects.toThrow('boom');
  });
});

describe('runCheck', () => {
  it('reports a healthy probe as up', async () => {
    const check = await runCheck('database', async () => ({ status: 'up' }));
    expect(check).toMatchObject({ name: 'database', status: 'up' });
  });

  it('records the probe duration', async () => {
    let now = 1000;
    const check = await runCheck(
      'database',
      async () => { now += 42; return { status: 'up' }; },
      1000,
      () => now
    );
    expect(check.durationMs).toBe(42);
  });

  it('reports a thrown error as down without leaking the message', async () => {
    const check = await runCheck('database', async () => {
      throw new Error('connect ECONNREFUSED postgres://user:hunter2@10.0.0.1:5432/db');
    });

    expect(check.status).toBe('down');
    expect(check.detail).toBe('unreachable');
    expect(JSON.stringify(check)).not.toContain('hunter2');
    expect(JSON.stringify(check)).not.toContain('10.0.0.1');
  });

  it('reports a hung probe as down rather than hanging the caller', async () => {
    const check = await runCheck('redis', () => new Promise(() => {}), 20);
    expect(check.status).toBe('down');
    expect(check.detail).toContain('timed out');
  });

  it('one hung dependency does not delay the others', async () => {
    const started = Date.now();

    const checks = await Promise.all([
      runCheck('database', async () => ({ status: 'up' as const }), 5_000),
      runCheck('redis', () => new Promise(() => {}), 30),
    ]);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(checks.map((c) => c.status)).toEqual(['up', 'down']);
  });

  it('defaults to the shared timeout', () => {
    expect(DEFAULT_CHECK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe('databaseProbe', () => {
  it('is up when the query succeeds', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) };
    await expect(databaseProbe(db)()).resolves.toEqual({ status: 'up' });
    expect(db.$queryRaw).toHaveBeenCalledOnce();
  });

  it('lets the error through so runCheck can classify it', async () => {
    const db = { $queryRaw: vi.fn().mockRejectedValue(new Error('down')) };
    await expect(databaseProbe(db)()).rejects.toThrow();
  });

  it('reports down through runCheck when the database is unreachable', async () => {
    const db = { $queryRaw: vi.fn().mockRejectedValue(new Error('down')) };
    const check = await runCheck('database', databaseProbe(db));
    expect(check.status).toBe('down');
  });
});

describe('redisProbe', () => {
  it('is up on PONG', async () => {
    const client = { ping: vi.fn().mockResolvedValue('PONG') };
    await expect(redisProbe(client)()).resolves.toEqual({ status: 'up' });
  });

  it('accepts a lowercase pong', async () => {
    const client = { ping: vi.fn().mockResolvedValue('pong') };
    await expect(redisProbe(client)()).resolves.toEqual({ status: 'up' });
  });

  it('is down on an unexpected reply', async () => {
    const client = { ping: vi.fn().mockResolvedValue('') };
    await expect(redisProbe(client)()).resolves.toMatchObject({ status: 'down' });
  });

  it('is down on a non-string reply', async () => {
    const client = { ping: vi.fn().mockResolvedValue(undefined as unknown as string) };
    await expect(redisProbe(client)()).resolves.toMatchObject({ status: 'down' });
  });
});

describe('queueProbe', () => {
  it('is up with a shallow queue and reports the counts', async () => {
    const queue = { getJobCounts: vi.fn().mockResolvedValue({ waiting: 3, active: 1, failed: 0 }) };
    await expect(queueProbe(queue)()).resolves.toEqual({
      status: 'up',
      meta: { waiting: 3, active: 1, failed: 0 },
    });
  });

  it('is degraded — not down — when the backlog is deep', async () => {
    // A backlog means the instance is behind, not broken. Failing readiness here
    // would pull it out of rotation and make the backlog worse.
    const queue = {
      getJobCounts: vi.fn().mockResolvedValue({
        waiting: QUEUE_DEPTH_DEGRADED_THRESHOLD + 1,
        active: 0,
        failed: 0,
      }),
    };
    const outcome = await queueProbe(queue)();
    expect(outcome.status).toBe('degraded');
  });

  it('honours a custom threshold', async () => {
    const queue = { getJobCounts: vi.fn().mockResolvedValue({ waiting: 5, active: 0, failed: 0 }) };
    await expect(queueProbe(queue, 2)()).resolves.toMatchObject({ status: 'degraded' });
    await expect(queueProbe(queue, 10)()).resolves.toMatchObject({ status: 'up' });
  });

  it('tolerates missing count keys', async () => {
    const queue = { getJobCounts: vi.fn().mockResolvedValue({}) };
    await expect(queueProbe(queue)()).resolves.toEqual({
      status: 'up',
      meta: { waiting: 0, active: 0, failed: 0 },
    });
  });
});

describe('summarize', () => {
  const required = ['database', 'redis'];

  it('is ok when everything required is up', () => {
    const report = summarize([result('database', 'up'), result('redis', 'up')], required);
    expect(report.status).toBe('ok');
  });

  it('is error when a required dependency is down', () => {
    const report = summarize([result('database', 'down'), result('redis', 'up')], required);
    expect(report.status).toBe('error');
  });

  it('is degraded when a non-required check is degraded', () => {
    const report = summarize(
      [result('database', 'up'), result('redis', 'up'), result('queue', 'degraded')],
      required
    );
    expect(report.status).toBe('degraded');
  });

  it('does not fail on a non-required dependency being down', () => {
    const report = summarize(
      [result('database', 'up'), result('redis', 'up'), result('queue', 'down')],
      required
    );
    expect(report.status).toBe('ok');
  });

  it('treats a skipped dependency as a valid state, not an outage', () => {
    const report = summarize([result('database', 'skipped'), result('redis', 'skipped')], required);
    expect(report.status).toBe('ok');
  });

  it('prefers error over degraded when both are present', () => {
    const report = summarize(
      [result('database', 'down'), result('redis', 'up'), result('queue', 'degraded')],
      required
    );
    expect(report.status).toBe('error');
  });

  it('returns every check it was given', () => {
    const checks = [result('database', 'up'), result('redis', 'up'), result('queue', 'up')];
    expect(summarize(checks, required).checks).toHaveLength(3);
  });

  it('is ok for an empty check list', () => {
    expect(summarize([], required).status).toBe('ok');
  });
});

describe('statusCodeFor', () => {
  it('sheds traffic only on a hard failure', () => {
    expect(statusCodeFor({ status: 'error', checks: [] })).toBe(503);
    expect(statusCodeFor({ status: 'degraded', checks: [] })).toBe(200);
    expect(statusCodeFor({ status: 'ok', checks: [] })).toBe(200);
  });
});

describe('end-to-end readiness shaping', () => {
  it('reports 503 with per-dependency detail when Redis is unreachable', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([1]) };
    const client = { ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')) };
    const queue = { getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, failed: 0 }) };

    const checks = await Promise.all([
      runCheck('database', databaseProbe(db)),
      runCheck('redis', redisProbe(client)),
      runCheck('queue', queueProbe(queue)),
    ]);

    const report = summarize(checks, ['database', 'redis']);

    expect(statusCodeFor(report)).toBe(503);
    expect(report.checks.find((c) => c.name === 'database')?.status).toBe('up');
    expect(report.checks.find((c) => c.name === 'redis')?.status).toBe('down');
    // The response body is reachable by anything that can reach the app, so it
    // must not carry connection details.
    expect(JSON.stringify(report)).not.toContain('6379');
  });

  it('reports 200 when every dependency is healthy', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([1]) };
    const client = { ping: vi.fn().mockResolvedValue('PONG') };
    const queue = { getJobCounts: vi.fn().mockResolvedValue({ waiting: 2, active: 1, failed: 0 }) };

    const checks = await Promise.all([
      runCheck('database', databaseProbe(db)),
      runCheck('redis', redisProbe(client)),
      runCheck('queue', queueProbe(queue)),
    ]);

    expect(statusCodeFor(summarize(checks, ['database', 'redis']))).toBe(200);
  });
});
