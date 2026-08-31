import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pool wiring for the Prisma client (#688).
 *
 * The behaviour that mattered most here — an idle client erroring with no
 * listener attached, which `EventEmitter` re-throws as an uncaught exception —
 * could not be observed without constructing a real pool, so it was never
 * covered. Faking `pg` makes it a two-line assertion.
 */

// vitest.setup.ts stubs `@/lib/prisma` for every test file so nothing opens a
// real connection. This file is testing that module itself, so it opts out and
// fakes the layer below instead: `pg`, the Prisma client, and the adapter.
vi.unmock('@/lib/prisma');

/** The pools constructed during a test, in order. */
const constructedPools: FakePool[] = [];

class FakePool {
  public readonly options: Record<string, unknown>;
  public readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  constructor(options: Record<string, unknown>) {
    this.options = options;
    constructedPools.push(this);
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(handler);
    this.listeners.set(event, existing);
    return this;
  }

  /** What `EventEmitter` does: with no listener, an 'error' is thrown. */
  emit(event: string, ...args: unknown[]): boolean {
    const handlers = this.listeners.get(event) ?? [];
    if (handlers.length === 0) {
      if (event === 'error') throw args[0];
      return false;
    }
    for (const handler of handlers) handler(...args);
    return true;
  }

  async connect(): Promise<unknown> {
    return { release: () => {} };
  }

  async query(): Promise<unknown> {
    return { rows: [] };
  }
}

vi.mock('pg', () => ({ Pool: FakePool }));
vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: class { constructor(public pool: unknown) {} } }));
vi.mock('@prisma/client', () => ({ PrismaClient: class { constructor(public options: unknown) {} } }));

const logged: { level: string; message: string }[] = [];
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    level: 'debug',
    debug: (message: string) => logged.push({ level: 'debug', message }),
    info: (message: string) => logged.push({ level: 'info', message }),
    warn: (message: string) => logged.push({ level: 'warn', message }),
    error: (message: string) => logged.push({ level: 'error', message }),
    child: () => ({}) as never,
  }),
  logger: {},
}));

const ORIGINAL_ENV = { ...process.env };

/** Import `prisma.ts` fresh under a controlled environment. */
async function importWithEnv(overrides: Record<string, string | undefined>) {
  for (const key of ['DATABASE_URL', 'DATABASE_POOL_URL', 'DB_POOL_MAX', 'NEXT_PUBLIC_MOCK_DB', 'CI', 'NEXT_PHASE']) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  vi.resetModules();
  vi.doUnmock('@/lib/prisma');
  return import('./prisma');
}

beforeEach(() => {
  constructedPools.length = 0;
  logged.length = 0;
  // The module memoises on globalThis in non-production, which would hand the
  // previous test's client back.
  delete (globalThis as { prismaGlobal?: unknown }).prismaGlobal;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete (globalThis as { prismaGlobal?: unknown }).prismaGlobal;
});

describe('the pool has an error listener', () => {
  it('attaches one, so an idle-client failure is not an uncaught exception', async () => {
    // pg.Pool emits 'error' when a client sitting idle in the pool hits a
    // network failure — a Postgres restart, a PgBouncer recycle. No try/catch
    // in the application can see it, and an unhandled 'error' on an
    // EventEmitter terminates the process.
    await importWithEnv({ DATABASE_URL: 'postgresql://u:p@db/app' });

    expect(constructedPools).toHaveLength(1);
    expect(constructedPools[0].listeners.get('error')).toHaveLength(1);
  });

  it('swallows the event and logs it rather than rethrowing', async () => {
    await importWithEnv({ DATABASE_URL: 'postgresql://u:p@db/app' });

    expect(() =>
      constructedPools[0].emit('error', new Error('Connection terminated unexpectedly'))
    ).not.toThrow();

    expect(logged.some((entry) => entry.level === 'error' && /idle/i.test(entry.message)))
      .toBe(true);
  });

  it('the fake reproduces the failure when no listener is attached', async () => {
    // Guards the test itself: if FakePool did not rethrow, the assertion above
    // would pass for a pool with no listener too.
    const bare = new FakePool({});
    expect(() => bare.emit('error', new Error('boom'))).toThrow('boom');
  });
});

describe('pool sizing', () => {
  it('clamps an unparseable DB_POOL_MAX instead of passing NaN to pg', async () => {
    await importWithEnv({ DATABASE_URL: 'postgresql://u:p@db/app', DB_POOL_MAX: 'abc' });

    expect(Number.isFinite(constructedPools[0].options.max)).toBe(true);
    expect(constructedPools[0].options.max).toBe(10);
  });

  it('honours a sane DB_POOL_MAX', async () => {
    await importWithEnv({ DATABASE_URL: 'postgresql://u:p@db/app', DB_POOL_MAX: '25' });
    expect(constructedPools[0].options.max).toBe(25);
  });

  it('warns about a value it had to change', async () => {
    await importWithEnv({ DATABASE_URL: 'postgresql://u:p@db/app', DB_POOL_MAX: '0' });

    expect(logged.some((entry) => entry.level === 'warn' && /DB_POOL_MAX/.test(entry.message)))
      .toBe(true);
  });
});

describe('a missing connection string', () => {
  it('does not prevent the module from being imported', async () => {
    // `next build` imports this module, runs no queries, and has no database.
    const mod = await importWithEnv({});
    expect(mod.default).toBeDefined();
  });

  it('is reported at import rather than left silent', async () => {
    await importWithEnv({});

    expect(logged.some((entry) => /DATABASE_URL/.test(entry.message))).toBe(true);
  });

  it('makes the first query fail with the reason, not with a libpq fallback error', async () => {
    // `new Pool({ connectionString: undefined })` does not fail; it tries the
    // local Unix socket as $USER, and the deployment reports `role "nextjs"
    // does not exist` some time later.
    await importWithEnv({});

    const pool = constructedPools[0];
    await expect(pool.query()).rejects.toThrow(/DATABASE_URL/);
    await expect(pool.connect()).rejects.toThrow(/DATABASE_URL/);
  });

  it('leaves a configured pool query path alone', async () => {
    await importWithEnv({ DATABASE_URL: 'postgresql://u:p@db/app' });

    await expect(constructedPools[0].query()).resolves.toBeDefined();
  });
});

describe('NEXT_PUBLIC_MOCK_DB', () => {
  it('serves the mock client in development, loudly', async () => {
    await importWithEnv({ NEXT_PUBLIC_MOCK_DB: 'true' });

    expect(constructedPools).toHaveLength(0);
    expect(logged.some((entry) => entry.level === 'warn' && /fabricated/.test(entry.message)))
      .toBe(true);
  });

  it('does not build a pool when the mock is in use', async () => {
    await importWithEnv({ NEXT_PUBLIC_MOCK_DB: 'true', DATABASE_URL: 'postgresql://u:p@db/app' });
    expect(constructedPools).toHaveLength(0);
  });
});

describe('getPgPoolConfig', () => {
  it('accepts an override connection string', async () => {
    const mod = await importWithEnv({ DATABASE_URL: 'postgresql://u:p@db/app' });

    expect(mod.getPgPoolConfig('postgresql://other/db').connectionString)
      .toBe('postgresql://other/db');
  });

  it('resolves the pooler URL ahead of the direct one', async () => {
    const mod = await importWithEnv({
      DATABASE_URL: 'postgresql://direct/db',
      DATABASE_POOL_URL: 'postgresql://pooled/db',
    });

    expect(mod.getDatabaseConnectionString()).toBe('postgresql://pooled/db');
  });

  it('returns undefined rather than an empty string when nothing is set', async () => {
    const mod = await importWithEnv({});
    expect(mod.getDatabaseConnectionString()).toBeUndefined();
  });
});
