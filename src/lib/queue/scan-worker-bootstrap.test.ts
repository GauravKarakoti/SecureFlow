import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SCAN_WORKER_CONCURRENCY,
  MAX_SCAN_WORKER_CONCURRENCY,
  ScanWorkerConfigError,
  describeWorkerStartup,
  planWorkerStartup,
  resolveScanWorkerConcurrency,
  shouldStartScanWorker,
} from './scan-worker-bootstrap';

describe('shouldStartScanWorker', () => {
  it('defaults to on when the variable is unset', () => {
    // The queue having no consumer is the bug. Requiring an extra variable to
    // fix it would leave every existing deployment broken after upgrading.
    expect(shouldStartScanWorker({})).toBe(true);
  });

  it.each(['0', 'false', 'no', 'off', 'disabled'])('is off for %s', (value) => {
    expect(shouldStartScanWorker({ SCAN_WORKER_ENABLED: value })).toBe(false);
  });

  it('ignores case and surrounding whitespace on the opt-out', () => {
    expect(shouldStartScanWorker({ SCAN_WORKER_ENABLED: '  FALSE  ' })).toBe(false);
    expect(shouldStartScanWorker({ SCAN_WORKER_ENABLED: 'Off' })).toBe(false);
  });

  it.each(['1', 'true', 'yes', 'on', 'anything else'])('is on for %s', (value) => {
    expect(shouldStartScanWorker({ SCAN_WORKER_ENABLED: value })).toBe(true);
  });

  it('is on for an empty value, which is an unset variable in most shells', () => {
    expect(shouldStartScanWorker({ SCAN_WORKER_ENABLED: '' })).toBe(true);
  });
});

describe('resolveScanWorkerConcurrency', () => {
  it('falls back to the default when unset', () => {
    expect(resolveScanWorkerConcurrency({})).toBe(DEFAULT_SCAN_WORKER_CONCURRENCY);
    expect(resolveScanWorkerConcurrency({ SCAN_WORKER_CONCURRENCY: '' })).toBe(
      DEFAULT_SCAN_WORKER_CONCURRENCY,
    );
    expect(resolveScanWorkerConcurrency({ SCAN_WORKER_CONCURRENCY: '   ' })).toBe(
      DEFAULT_SCAN_WORKER_CONCURRENCY,
    );
  });

  it('reads a configured value', () => {
    expect(resolveScanWorkerConcurrency({ SCAN_WORKER_CONCURRENCY: '8' })).toBe(8);
    expect(resolveScanWorkerConcurrency({ SCAN_WORKER_CONCURRENCY: ' 8 ' })).toBe(8);
  });

  it('throws rather than producing NaN for a non-numeric value', () => {
    // `workerPool` builds its singleton with `parseInt(raw, 10)`, which answers
    // NaN for 'three'. A NaN concurrency is not a loud failure — the worker
    // simply processes nothing, which is the exact symptom of the bug this
    // module exists to fix, with no error anywhere to explain it.
    expect(() => resolveScanWorkerConcurrency({ SCAN_WORKER_CONCURRENCY: 'three' })).toThrow(
      ScanWorkerConfigError,
    );
    expect(() => resolveScanWorkerConcurrency({ SCAN_WORKER_CONCURRENCY: '4abc' })).toThrow(
      ScanWorkerConfigError,
    );
    expect(() => resolveScanWorkerConcurrency({ SCAN_WORKER_CONCURRENCY: '2.5' })).toThrow(
      ScanWorkerConfigError,
    );
  });

  it('rejects zero, which would consume nothing while looking configured', () => {
    expect(() => resolveScanWorkerConcurrency({ SCAN_WORKER_CONCURRENCY: '0' })).toThrow(
      ScanWorkerConfigError,
    );
  });

  it('rejects a value above the ceiling', () => {
    expect(() =>
      resolveScanWorkerConcurrency({
        SCAN_WORKER_CONCURRENCY: String(MAX_SCAN_WORKER_CONCURRENCY + 1),
      }),
    ).toThrow(ScanWorkerConfigError);
  });

  it('accepts the boundary values', () => {
    expect(resolveScanWorkerConcurrency({ SCAN_WORKER_CONCURRENCY: '1' })).toBe(1);
    expect(
      resolveScanWorkerConcurrency({
        SCAN_WORKER_CONCURRENCY: String(MAX_SCAN_WORKER_CONCURRENCY),
      }),
    ).toBe(MAX_SCAN_WORKER_CONCURRENCY);
  });

  it('names the variable and the offending value', () => {
    expect(() => resolveScanWorkerConcurrency({ SCAN_WORKER_CONCURRENCY: 'three' })).toThrow(
      /SCAN_WORKER_CONCURRENCY/,
    );
    expect(() => resolveScanWorkerConcurrency({ SCAN_WORKER_CONCURRENCY: 'three' })).toThrow(
      /"three"/,
    );
  });
});

describe('planWorkerStartup', () => {
  it('includes the scan queue by default', () => {
    // This is the assertion that would have failed on main: the entry point
    // consumed github-webhooks and outbound-webhooks and nothing else, so
    // vulnerability-scans had a producer and no consumer.
    const plan = planWorkerStartup({});

    expect(plan.queues).toEqual([
      'github-webhooks',
      'outbound-webhooks',
      'vulnerability-scans',
    ]);
    expect(plan.scanWorkerEnabled).toBe(true);
    expect(plan.scanConcurrency).toBe(DEFAULT_SCAN_WORKER_CONCURRENCY);
  });

  it('drops the scan queue when the worker is turned off', () => {
    const plan = planWorkerStartup({ SCAN_WORKER_ENABLED: 'false' });

    expect(plan.queues).not.toContain('vulnerability-scans');
    expect(plan.scanWorkerEnabled).toBe(false);
    expect(plan.scanConcurrency).toBeNull();
  });

  it('keeps the webhook queues regardless', () => {
    const plan = planWorkerStartup({ SCAN_WORKER_ENABLED: 'off' });

    expect(plan.queues).toEqual(['github-webhooks', 'outbound-webhooks']);
  });

  it('carries the configured concurrency', () => {
    expect(planWorkerStartup({ SCAN_WORKER_CONCURRENCY: '6' }).scanConcurrency).toBe(6);
  });

  it('does not validate concurrency the process will not use', () => {
    // Turning the worker off should not make an unrelated stale variable fatal.
    expect(() =>
      planWorkerStartup({ SCAN_WORKER_ENABLED: 'false', SCAN_WORKER_CONCURRENCY: 'nonsense' }),
    ).not.toThrow();
  });

  it('fails at startup for a bad concurrency it will use', () => {
    expect(() => planWorkerStartup({ SCAN_WORKER_CONCURRENCY: 'nonsense' })).toThrow(
      ScanWorkerConfigError,
    );
  });
});

describe('describeWorkerStartup', () => {
  it('names every queue being consumed', () => {
    const line = describeWorkerStartup(planWorkerStartup({}));

    expect(line).toContain('github-webhooks');
    expect(line).toContain('outbound-webhooks');
    expect(line).toContain('vulnerability-scans');
    expect(line).toContain('concurrency=3');
  });

  it('says so when the scan worker is off', () => {
    const line = describeWorkerStartup(planWorkerStartup({ SCAN_WORKER_ENABLED: 'false' }));

    expect(line).toContain('scan worker off');
    expect(line).toContain('SCAN_WORKER_ENABLED');
    expect(line).not.toContain('vulnerability-scans');
  });
});
