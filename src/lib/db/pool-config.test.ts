import { describe, expect, it } from 'vitest';

import {
  CONNECTION_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  IDLE_TIMEOUT_MS,
  MAX_POOL_MAX,
  MIN_POOL_MAX,
  MISSING_CONNECTION_STRING_MESSAGE,
  resolveConnectionString,
  resolveMockDb,
  resolvePoolConfig,
  resolvePoolMax,
} from './pool-config';

/** A bare environment, so no test depends on the runner's own variables. */
const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  overrides as NodeJS.ProcessEnv;

const DIRECT = 'postgresql://user:pw@db.example.com/app';
const POOLED = 'postgresql://user:pw@db-pooler.example.com/app';

describe('resolvePoolMax', () => {
  it('defaults when DB_POOL_MAX is unset', () => {
    const { value, warning } = resolvePoolMax(env());

    expect(value).toBe(DEFAULT_POOL_MAX);
    expect(warning).toBeUndefined();
  });

  it('accepts a value inside the bounds', () => {
    expect(resolvePoolMax(env({ DB_POOL_MAX: '25' })).value).toBe(25);
  });

  it('tolerates surrounding whitespace', () => {
    expect(resolvePoolMax(env({ DB_POOL_MAX: ' 25 ' })).value).toBe(25);
  });

  it('never yields NaN for an unparseable value', () => {
    // `parseInt('abc', 10)` is NaN, and NaN is what reached `new Pool({ max })`.
    const { value, warning } = resolvePoolMax(env({ DB_POOL_MAX: 'abc' }));

    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBe(DEFAULT_POOL_MAX);
    expect(warning).toMatch(/not a number/);
  });

  it('treats an empty value as unset rather than as zero', () => {
    const { value, warning } = resolvePoolMax(env({ DB_POOL_MAX: '' }));

    expect(value).toBe(DEFAULT_POOL_MAX);
    expect(warning).toBeUndefined();
  });

  it('refuses to disable the pool entirely', () => {
    // DB_POOL_MAX=0 was passed straight through, leaving no usable connections.
    const { value, warning } = resolvePoolMax(env({ DB_POOL_MAX: '0' }));

    expect(value).toBe(MIN_POOL_MAX);
    expect(warning).toMatch(/no usable connections/);
  });

  it('clamps a negative value', () => {
    expect(resolvePoolMax(env({ DB_POOL_MAX: '-1' })).value).toBe(MIN_POOL_MAX);
  });

  it('clamps an implausibly large value', () => {
    const { value, warning } = resolvePoolMax(env({ DB_POOL_MAX: '100000' }));

    expect(value).toBe(MAX_POOL_MAX);
    expect(warning).toMatch(/multiplies/);
  });

  it('always returns a usable integer, for any input', () => {
    const inputs = ['abc', '', ' ', '0', '-5', '1e3', '3.7', '99999999', 'Infinity', 'NaN'];

    for (const raw of inputs) {
      const { value } = resolvePoolMax(env({ DB_POOL_MAX: raw }));

      expect(Number.isInteger(value), raw).toBe(true);
      expect(value, raw).toBeGreaterThanOrEqual(MIN_POOL_MAX);
      expect(value, raw).toBeLessThanOrEqual(MAX_POOL_MAX);
    }
  });
});

describe('resolveConnectionString', () => {
  it('prefers the pooler URL', () => {
    expect(resolveConnectionString(env({ DATABASE_URL: DIRECT, DATABASE_POOL_URL: POOLED })))
      .toBe(POOLED);
  });

  it('prefers the pooler URL in development too', () => {
    // The old code had a production-only branch above a line that already
    // preferred DATABASE_POOL_URL unconditionally, so the branch was a no-op.
    expect(
      resolveConnectionString(
        env({ NODE_ENV: 'development', DATABASE_URL: DIRECT, DATABASE_POOL_URL: POOLED })
      )
    ).toBe(POOLED);
  });

  it('falls back to the direct URL', () => {
    expect(resolveConnectionString(env({ DATABASE_URL: DIRECT }))).toBe(DIRECT);
  });

  it('trims the value', () => {
    expect(resolveConnectionString(env({ DATABASE_URL: `  ${DIRECT}  ` }))).toBe(DIRECT);
  });

  it('treats a blank value as unset', () => {
    // A `DATABASE_URL=` line left in a .env is a variable someone meant to fill
    // in, not an intentional empty string.
    expect(resolveConnectionString(env({ DATABASE_URL: '   ' }))).toBeNull();
  });

  it('skips a blank pooler URL rather than losing the direct one', () => {
    expect(resolveConnectionString(env({ DATABASE_POOL_URL: '', DATABASE_URL: DIRECT })))
      .toBe(DIRECT);
  });

  it('returns null when nothing is configured', () => {
    expect(resolveConnectionString(env())).toBeNull();
  });
});

describe('resolvePoolConfig', () => {
  it('builds the full option set', () => {
    const { config, unconfigured, warnings } = resolvePoolConfig(
      env({ DATABASE_URL: DIRECT, DB_POOL_MAX: '20' })
    );

    expect(config).toEqual({
      connectionString: DIRECT,
      max: 20,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    });
    expect(unconfigured).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('flags a missing connection string rather than throwing', () => {
    // Not a throw: this module is imported during `next build`, which runs no
    // queries and legitimately has no database. Failing the build over a
    // connection that is never opened trades one wrong error for another.
    const { unconfigured, warnings } = resolvePoolConfig(env());

    expect(unconfigured).toBe(true);
    expect(warnings).toContain(MISSING_CONNECTION_STRING_MESSAGE);
  });

  it('names DATABASE_URL in the message', () => {
    // The point of the message: the observed failure was `role "nextjs" does
    // not exist`, which points at the wrong thing entirely.
    expect(MISSING_CONNECTION_STRING_MESSAGE).toContain('DATABASE_URL');
  });

  it('reports both problems at once', () => {
    const { warnings } = resolvePoolConfig(env({ DB_POOL_MAX: 'abc' }));

    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes('DB_POOL_MAX'))).toBe(true);
    expect(warnings).toContain(MISSING_CONNECTION_STRING_MESSAGE);
  });

  it('never produces a NaN pool size', () => {
    const { config } = resolvePoolConfig(env({ DATABASE_URL: DIRECT, DB_POOL_MAX: 'ten' }));
    expect(Number.isFinite(config.max)).toBe(true);
  });
});

describe('resolveMockDb', () => {
  it('is off unless explicitly requested', () => {
    expect(resolveMockDb(env())).toEqual({ requested: false, allowed: false });
    expect(resolveMockDb(env({ NEXT_PUBLIC_MOCK_DB: 'false' })).requested).toBe(false);
  });

  it('only recognises the exact string', () => {
    expect(resolveMockDb(env({ NEXT_PUBLIC_MOCK_DB: '1' })).requested).toBe(false);
    expect(resolveMockDb(env({ NEXT_PUBLIC_MOCK_DB: 'TRUE' })).requested).toBe(false);
  });

  it('allows it in development', () => {
    const decision = resolveMockDb(
      env({ NEXT_PUBLIC_MOCK_DB: 'true', NODE_ENV: 'development' })
    );

    expect(decision.allowed).toBe(true);
    expect(decision.refusal).toBeUndefined();
  });

  it('allows it under test', () => {
    expect(resolveMockDb(env({ NEXT_PUBLIC_MOCK_DB: 'true', NODE_ENV: 'test' })).allowed)
      .toBe(true);
  });

  it('refuses it in a production runtime', () => {
    const decision = resolveMockDb(
      env({ NEXT_PUBLIC_MOCK_DB: 'true', NODE_ENV: 'production' })
    );

    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toMatch(/ADMIN/);
  });

  it('still allows it in CI, which is what our own E2E job needs', () => {
    // The E2E workflow runs `next build` with NEXT_PUBLIC_MOCK_DB: 'true', and
    // `next build` sets NODE_ENV=production. Refusing on NODE_ENV alone would
    // fail this repository's own pipeline.
    expect(
      resolveMockDb(env({ NEXT_PUBLIC_MOCK_DB: 'true', NODE_ENV: 'production', CI: 'true' }))
        .allowed
    ).toBe(true);
  });

  it('still allows it during a Next build phase', () => {
    expect(
      resolveMockDb(
        env({
          NEXT_PUBLIC_MOCK_DB: 'true',
          NODE_ENV: 'production',
          NEXT_PHASE: 'phase-production-build',
        })
      ).allowed
    ).toBe(true);
  });

  it('refuses on a deployed server, where neither CI nor NEXT_PHASE is set', () => {
    // This is the boundary that matters: a running deployment, not a build.
    expect(
      resolveMockDb(
        env({ NEXT_PUBLIC_MOCK_DB: 'true', NODE_ENV: 'production', PORT: '3000' })
      ).allowed
    ).toBe(false);
  });
});
