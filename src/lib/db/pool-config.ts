/**
 * Connection-pool configuration, separated from the Prisma client (#688).
 *
 * `src/lib/prisma.ts` builds the `pg` pool by hand and then hands it to
 * `PrismaPg`. Three of the decisions it made along the way were wrong, and none
 * of them were covered by a test — because none of them were reachable without
 * constructing a real client.
 *
 *  - **`DB_POOL_MAX` was parsed with a bare `parseInt`.** `DB_POOL_MAX=abc`
 *    produced `new Pool({ max: NaN })`; `0` disabled the pool; `-1` and
 *    `100000` were passed through as written. A typo in a deployment variable
 *    should not silently reconfigure the pool into a broken state, and
 *    everywhere else in this codebase that reads a numeric env var clamps it —
 *    `resolveDispatchConfig` in `src/lib/queue/outbound-dispatch.ts` is the
 *    model this follows.
 *
 *  - **A missing connection string was not an error.** `new Pool({
 *    connectionString: undefined })` does not fail; libpq semantics take over
 *    and it tries the local Unix socket as `$USER`. The deployment then fails
 *    much later with `role "nextjs" does not exist`, which points at entirely
 *    the wrong thing. The real fault — "you did not configure a database" —
 *    should be stated where it happens.
 *
 *  - **The production branch of `getDatabaseConnectionString` was a no-op.** It
 *    returned `DATABASE_POOL_URL` when set and in production, then fell through
 *    to a line that already prefers `DATABASE_POOL_URL` unconditionally.
 *
 * Everything here is pure and takes its environment as an argument, so the
 * clamping and the precedence are testable without a database, a build, or a
 * `process.env` mutation.
 */

/** Pool size used when `DB_POOL_MAX` is unset or unusable. */
export const DEFAULT_POOL_MAX = 10;

/**
 * Bounds on a configured pool size.
 *
 * The upper bound is not arbitrary: a serverless deployment runs many instances
 * of this process against one Postgres, so the per-instance ceiling multiplies.
 * A value above this is far more likely to be a typo than an intention, and the
 * failure it causes — `too many connections` on the database, affecting every
 * instance — is the one this cap exists to prevent.
 */
export const MIN_POOL_MAX = 1;
export const MAX_POOL_MAX = 100;

/** Milliseconds an idle client is kept before the pool closes it. */
export const IDLE_TIMEOUT_MS = 30_000;

/** Milliseconds to wait for a connection before giving up. */
export const CONNECTION_TIMEOUT_MS = 10_000;

export interface PoolMaxResolution {
  /** The value to hand to `pg`. Always within bounds. */
  value: number;
  /** Set when the configured value was unusable, for the operator to see. */
  warning?: string;
}

/**
 * Resolve `DB_POOL_MAX` into a usable pool size.
 *
 * Returns the reason alongside the value rather than logging from here, so this
 * stays pure and the caller decides where a warning goes.
 */
export function resolvePoolMax(env: NodeJS.ProcessEnv = process.env): PoolMaxResolution {
  const raw = env.DB_POOL_MAX;

  if (raw === undefined || raw.trim() === '') {
    return { value: DEFAULT_POOL_MAX };
  }

  const parsed = Number.parseInt(raw.trim(), 10);

  if (!Number.isFinite(parsed)) {
    return {
      value: DEFAULT_POOL_MAX,
      warning: `DB_POOL_MAX="${raw}" is not a number; using ${DEFAULT_POOL_MAX}.`,
    };
  }

  if (parsed < MIN_POOL_MAX) {
    return {
      value: MIN_POOL_MAX,
      warning: `DB_POOL_MAX=${parsed} would leave no usable connections; using ${MIN_POOL_MAX}.`,
    };
  }

  if (parsed > MAX_POOL_MAX) {
    return {
      value: MAX_POOL_MAX,
      warning:
        `DB_POOL_MAX=${parsed} exceeds the per-instance ceiling of ${MAX_POOL_MAX}; ` +
        `using ${MAX_POOL_MAX}. Every instance opens its own pool, so this multiplies.`,
    };
  }

  return { value: parsed };
}

/**
 * The connection string to use, or `null` when none is configured.
 *
 * `DATABASE_POOL_URL` wins wherever it is set — it names a pooler (PgBouncer,
 * the Neon proxy), which is what a serverless deployment wants and what a local
 * one is unaffected by. `DATABASE_URL` is the direct connection and the
 * fallback.
 *
 * Whitespace-only values count as unset. A `DATABASE_URL=` line left in a `.env`
 * file is a variable someone meant to fill in, not an intentional empty string.
 */
export function resolveConnectionString(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const candidate of [env.DATABASE_POOL_URL, env.DATABASE_URL]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim();
    }
  }

  return null;
}

/** The message used when no connection string is configured. */
export const MISSING_CONNECTION_STRING_MESSAGE =
  'No database connection string is configured. Set DATABASE_URL (or DATABASE_POOL_URL ' +
  'to route through a connection pooler). Without one, the pg driver falls back to a ' +
  'local Unix socket and the failure surfaces later as an unrelated authentication error.';

/** Options handed to `new Pool()`. */
export interface PgPoolConfig {
  connectionString: string | undefined;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

export interface ResolvedPoolConfig {
  config: PgPoolConfig;
  /** True when no connection string was found; the pool cannot usefully connect. */
  unconfigured: boolean;
  /** Everything the operator should be told about, in the order it was found. */
  warnings: string[];
}

/**
 * Resolve the full pool configuration from an environment.
 *
 * Never throws. Reporting `unconfigured` rather than throwing is deliberate: the
 * module that owns the client is imported during `next build`, which does not
 * run a single query and legitimately has no database. Failing the build over a
 * connection that is never opened would trade one wrong error for another. The
 * caller uses this flag to make the *first query* fail with a message that says
 * what is actually wrong.
 */
export function resolvePoolConfig(env: NodeJS.ProcessEnv = process.env): ResolvedPoolConfig {
  const connectionString = resolveConnectionString(env);
  const poolMax = resolvePoolMax(env);
  const warnings: string[] = [];

  if (poolMax.warning) warnings.push(poolMax.warning);
  if (connectionString === null) warnings.push(MISSING_CONNECTION_STRING_MESSAGE);

  return {
    config: {
      connectionString: connectionString ?? undefined,
      max: poolMax.value,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    },
    unconfigured: connectionString === null,
    warnings,
  };
}

/** Whether the in-memory mock client should be used, and whether that is allowed. */
export interface MockDbDecision {
  requested: boolean;
  allowed: boolean;
  /** Set when the request is refused, explaining why. */
  refusal?: string;
}

/**
 * Decide whether `NEXT_PUBLIC_MOCK_DB` may take effect.
 *
 * The mock client answers `user.findUnique` with a hardcoded `ADMIN` and
 * `{ id: 'mock-id' }` for anything it does not recognise. An application serving
 * that is not degraded, it is lying — and because the flag carries the
 * `NEXT_PUBLIC_` prefix it is inlined at build time and is easy to copy into the
 * wrong `.env` by accident.
 *
 * The refusal is scoped to a production runtime that is not a build or a CI job.
 * That exemption is not a loophole for convenience — it is required by this
 * repository: the E2E workflow runs `next build` with `NEXT_PUBLIC_MOCK_DB:
 * 'true'`, and `next build` sets `NODE_ENV=production`, so refusing on
 * `NODE_ENV` alone would fail our own pipeline. `CI` is set by GitHub Actions
 * (and by Vercel during a build) and is absent on a deployed server, which is
 * exactly the boundary that matters here.
 */
export function resolveMockDb(env: NodeJS.ProcessEnv = process.env): MockDbDecision {
  const requested = env.NEXT_PUBLIC_MOCK_DB === 'true';
  if (!requested) return { requested: false, allowed: false };

  const isProductionRuntime =
    env.NODE_ENV === 'production' && !env.CI && !env.NEXT_PHASE;

  if (isProductionRuntime) {
    return {
      requested: true,
      allowed: false,
      refusal:
        'NEXT_PUBLIC_MOCK_DB=true refused in a production runtime. The mock client serves ' +
        'a hardcoded ADMIN user and fabricated counts; serving that from a deployment is ' +
        'worse than serving an error. Unset it, or set a real DATABASE_URL.',
    };
  }

  return { requested: true, allowed: true };
}
