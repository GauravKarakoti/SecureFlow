import { describe, it, expect, vi } from 'vitest';
import {
  LOG_LEVELS,
  REDACTED_PLACEHOLDER,
  buildRecord,
  createLogger,
  formatRecord,
  isSensitiveKey,
  redactMeta,
  redactValue,
  resolveLogLevel,
  sanitizeLogValue,
  shouldLog,
  type EmittableLevel,
} from './logger';

/** Collect emitted lines instead of writing to the real console. */
function capture(level = 'debug' as const) {
  const lines: Array<{ level: EmittableLevel; line: string }> = [];
  const logger = createLogger({
    level,
    pretty: false,
    sink: (emitted, line) => lines.push({ level: emitted, line }),
    now: () => new Date('2026-08-17T12:00:00.000Z'),
  });
  return { logger, lines, records: () => lines.map((entry) => JSON.parse(entry.line)) };
}

describe('sanitizeLogValue', () => {
  it('collapses CR and LF so a value cannot forge a record', () => {
    // A repository named `foo\n{"level":"INFO","message":"scan passed"}` is
    // otherwise enough to write a fake log line in any line-based aggregator.
    expect(sanitizeLogValue('foo\nbar')).toBe('foo bar');
    expect(sanitizeLogValue('foo\r\nbar')).toBe('foo bar');
  });

  it('also strips the Unicode line separators', () => {
    // Written as escapes on purpose: U+2028 and U+2029 are invisible in source,
    // and several log pipelines and JSON parsers treat them as terminators.
    expect(sanitizeLogValue('foo\u2028bar\u2029baz')).toBe('foo bar baz');
  });

  it('keeps tabs, which are not record separators', () => {
    expect(sanitizeLogValue('foo\tbar')).toBe('foo\tbar');
  });

  it('renders null and undefined as an empty string rather than "null"', () => {
    expect(sanitizeLogValue(null)).toBe('');
    expect(sanitizeLogValue(undefined)).toBe('');
  });
});

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'GITHUB_CLIENT_SECRET',
    'githubToken',
    'apiKey',
    'api_key',
    'Authorization',
    'x-hub-signature-256',
    'sessionToken',
    'DATABASE_URL',
    'privateKey',
  ])('flags %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['repository', 'deliveryId', 'severity', 'fileLocation', 'count'])(
    'leaves %s alone',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    }
  );
});

describe('redactValue', () => {
  it('replaces a value under a sensitive key entirely', () => {
    expect(redactMeta({ githubToken: 'ghp_realtoken' })).toEqual({
      githubToken: REDACTED_PLACEHOLDER,
    });
  });

  it('redacts nested values, not just top-level ones', () => {
    expect(
      redactMeta({ request: { headers: { authorization: 'Bearer abc' }, path: '/api' } })
    ).toEqual({
      request: { headers: { authorization: REDACTED_PLACEHOLDER }, path: '/api' },
    });
  });

  it('redacts inside arrays', () => {
    expect(redactMeta({ items: [{ secret: 'a' }, { secret: 'b' }] })).toEqual({
      items: [{ secret: REDACTED_PLACEHOLDER }, { secret: REDACTED_PLACEHOLDER }],
    });
  });

  it('scrubs a credential that appears in a value rather than a key', () => {
    const result = redactMeta({
      message: "Can't reach database server at postgresql://user:hunter2@db.host/neondb",
    }) as { message: string };

    expect(result.message).not.toContain('hunter2');
    expect(result.message).toContain('[REDACTED_CONNECTION_STRING]');
  });

  it('keeps repository-relative file paths, which are the useful part of a log', () => {
    // scrubSensitiveData also strips filesystem paths, which is right for a
    // client-facing message and wrong here.
    expect(redactMeta({ fileLocation: 'src/lib/armor/scanner.ts' })).toEqual({
      fileLocation: 'src/lib/armor/scanner.ts',
    });
  });

  it('sanitizes newlines inside metadata values too', () => {
    expect(redactMeta({ repo: 'org/repo\nINFO forged' })).toEqual({
      repo: 'org/repo INFO forged',
    });
  });

  it('flattens an Error into name/message/stack', () => {
    const error = new Error('boom');
    const result = redactValue(error) as { name: string; message: string };

    expect(result.name).toBe('Error');
    expect(result.message).toBe('boom');
  });

  it('survives a circular structure instead of throwing', () => {
    // A Prisma error carries request/response objects that reference each
    // other; without this the logger is the thing that crashes.
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;

    expect(() => redactMeta({ node })).not.toThrow();
    expect(JSON.stringify(redactMeta({ node }))).toContain('[Circular]');
  });

  it('stops descending past the depth limit', () => {
    const deep = { a: { b: { c: { d: { e: 'too far' } } } } };
    expect(JSON.stringify(redactMeta(deep))).toContain('[Truncated]');
  });

  it('caps a long array and says how much it dropped', () => {
    const serialized = JSON.stringify(redactMeta({ files: Array.from({ length: 200 }, (_, i) => `f${i}`) }));
    expect(serialized).toContain('150 more');
    expect(serialized).not.toContain('"f199"');
  });

  it('truncates an oversized string value', () => {
    const result = redactMeta({ snippet: 'x'.repeat(10_000) }) as { snippet: string };
    expect(result.snippet.length).toBeLessThan(2100);
    expect(result.snippet).toContain('truncated');
  });

  it('stringifies a bigint, which JSON.stringify would throw on', () => {
    // Repository.githubId and PullRequest.githubId are both BigInt columns.
    expect(redactMeta({ githubId: BigInt(123) })).toEqual({ githubId: '123' });
  });

  it('passes primitives through untouched', () => {
    expect(redactMeta({ count: 3, ok: true, missing: null })).toEqual({
      count: 3,
      ok: true,
      missing: null,
    });
  });
});

describe('resolveLogLevel', () => {
  it('honours an explicit LOG_LEVEL', () => {
    expect(resolveLogLevel({ NODE_ENV: 'production', LOG_LEVEL: 'warn' } as NodeJS.ProcessEnv)).toBe('warn');
    expect(resolveLogLevel({ NODE_ENV: 'production', LOG_LEVEL: ' ERROR ' } as NodeJS.ProcessEnv)).toBe('error');
  });

  it('ignores an unrecognised value rather than silencing production', () => {
    expect(
      resolveLogLevel({ LOG_LEVEL: 'verbose', NODE_ENV: 'production' } as NodeJS.ProcessEnv)
    ).toBe('info');
  });

  it('suppresses everything below error under test', () => {
    // Quiet enough that `vitest run` is not interleaved with worker and scanner
    // chatter, but errors still surface -- a test failing silently is worse.
    expect(resolveLogLevel({ NODE_ENV: 'production', VITEST: 'true' } as NodeJS.ProcessEnv)).toBe('error');
    expect(resolveLogLevel({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe('error');
  });

  it('defaults to debug in development and info elsewhere', () => {
    expect(resolveLogLevel({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe('debug');
    expect(resolveLogLevel({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe('info');
  });

  it('lets an explicit level override the test default', () => {
    expect(resolveLogLevel({ NODE_ENV: 'production', VITEST: 'true', LOG_LEVEL: 'debug' } as NodeJS.ProcessEnv)).toBe(
      'debug'
    );
  });
});

describe('shouldLog', () => {
  it('emits at or above the threshold', () => {
    expect(shouldLog('error', 'warn')).toBe(true);
    expect(shouldLog('warn', 'warn')).toBe(true);
    expect(shouldLog('info', 'warn')).toBe(false);
    expect(shouldLog('debug', 'info')).toBe(false);
  });

  it('emits nothing at all when silent', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as EmittableLevel[]) {
      expect(shouldLog(level, 'silent')).toBe(false);
    }
  });

  it('covers every declared level', () => {
    expect(LOG_LEVELS).toContain('silent');
    expect(LOG_LEVELS.length).toBe(5);
  });
});

describe('buildRecord / formatRecord', () => {
  const at = () => new Date('2026-08-17T12:00:00.000Z');

  it('carries timestamp, level and message', () => {
    expect(buildRecord('info', 'scan complete', undefined, {}, at)).toEqual({
      timestamp: '2026-08-17T12:00:00.000Z',
      level: 'INFO',
      message: 'scan complete',
    });
  });

  it('sanitizes and scrubs the message itself, not only the metadata', () => {
    const record = buildRecord(
      'error',
      'failed: postgresql://u:hunter2@h/db\nINFO forged',
      undefined,
      {},
      at
    );

    expect(record.message).not.toContain('hunter2');
    expect(record.message).not.toContain('\n');
  });

  it('merges bound context, with per-call metadata taking precedence', () => {
    const record = buildRecord('info', 'x', { step: 'scan' }, { deliveryId: 'd1', step: 'init' }, at);
    expect(record.deliveryId).toBe('d1');
    expect(record.step).toBe('scan');
  });

  it('emits JSON on one line for a log drain', () => {
    const line = formatRecord(buildRecord('info', 'hello', { a: 1 }, {}, at), false);
    expect(line.split('\n')).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({ level: 'INFO', message: 'hello', a: 1 });
  });

  it('emits a readable line in pretty mode', () => {
    const line = formatRecord(buildRecord('warn', 'careful', { a: 1 }, {}, at), true);
    expect(line).toContain('WARN');
    expect(line).toContain('careful');
    expect(line.startsWith('{')).toBe(false);
  });
});

describe('createLogger', () => {
  it('writes a record per level above the threshold', () => {
    const { logger, records } = capture();

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(records().map((record) => record.level)).toEqual(['DEBUG', 'INFO', 'WARN', 'ERROR']);
  });

  it('drops records below the threshold', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', pretty: false, sink: (_l, line) => lines.push(line) });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');

    expect(lines).toHaveLength(1);
  });

  it('writes nothing when silent', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'silent', sink: (_l, line) => lines.push(line) });

    logger.error('even this');

    expect(lines).toHaveLength(0);
  });

  it('routes warn and error to the error stream', () => {
    const { logger, lines } = capture();

    logger.warn('w');
    logger.error('e');
    logger.info('i');

    expect(lines.map((entry) => entry.level)).toEqual(['warn', 'error', 'info']);
  });

  it('binds context onto every record from a child', () => {
    // This is the correlation ID: one GitHub delivery fans out across the
    // route, the job, the scanner and the AI flow, and nothing used to tie the
    // records together.
    const { logger, records } = capture();
    const scoped = logger.child({ deliveryId: 'delivery-1' });

    scoped.info('queued');
    scoped.error('failed');

    expect(records().every((record) => record.deliveryId === 'delivery-1')).toBe(true);
  });

  it('merges context through nested children', () => {
    const { logger, records } = capture();

    logger.child({ deliveryId: 'd1' }).child({ repo: 'org/repo' }).info('scanning');

    expect(records()[0]).toMatchObject({ deliveryId: 'd1', repo: 'org/repo' });
  });

  it('does not leak a child context back to its parent', () => {
    const { logger, records } = capture();

    logger.child({ deliveryId: 'd1' }).info('child');
    logger.info('parent');

    expect(records()[1].deliveryId).toBeUndefined();
  });

  it('redacts metadata on the way out', () => {
    const { logger, records } = capture();

    logger.error('auth failed', { githubToken: 'ghp_real', repo: 'org/repo' });

    expect(records()[0].githubToken).toBe(REDACTED_PLACEHOLDER);
    expect(records()[0].repo).toBe('org/repo');
  });

  it('does not touch the console when a sink is supplied', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { logger } = capture();

    logger.info('quiet');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('exposes the resolved level', () => {
    expect(createLogger({ level: 'warn' }).level).toBe('warn');
    expect(createLogger({ level: 'warn' }).child({}).level).toBe('warn');
  });
});
