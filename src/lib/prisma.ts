import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { createLogger } from '@/lib/logger';
import {
  MISSING_CONNECTION_STRING_MESSAGE,
  resolveConnectionString,
  resolveMockDb,
  resolvePoolConfig,
  resolvePoolMax,
  type PgPoolConfig,
} from '@/lib/db/pool-config';

const log = createLogger({ context: { component: 'prisma' } });

// BigInt serialization fix: standard JSON.stringify() does not support BigInt values.
// Patching BigInt.prototype.toJSON allows objects with BigInt fields (such as Repository/PullRequest githubId)
// to be serialized safely in API responses.
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

BigInt.prototype.toJSON = function (this: bigint): string {
  return this.toString();
};

function createMockPrismaClient() {
  const mockFn = async (model: string, method: string, args: any[]) => {
    if (model === 'user') {
      if (method === 'count') {
        const rolesFilter = args[0]?.where?.roles;
        if (rolesFilter) {
          const roleName = rolesFilter.some?.role?.name;
          if (roleName === 'ADMIN') return 1;
          if (roleName === 'USER') return 2;
        }
        return 3;
      }
      if (method === 'findMany') {
        return [
          {
            id: 'mock-admin-id',
            name: 'Mock Admin',
            email: 'admin@secureflow.test',
            codename: 'Professor',
            image: null,
            roles: [{ role: { name: 'ADMIN' } }],
            _count: { repositories: 2 },
            createdAt: new Date(),
          },
          {
            id: 'user-2',
            name: 'Rio Developer',
            email: 'rio@secureflow.test',
            codename: 'Rio',
            image: null,
            roles: [{ role: { name: 'USER' } }],
            _count: { repositories: 1 },
            createdAt: new Date(Date.now() - 1000 * 3600 * 24),
          }
        ];
      }
      if (method === 'findUnique') {
        return {
          id: args[0]?.where?.id || 'mock-admin-id',
          name: 'Mock Admin',
          email: 'admin@secureflow.test',
          codename: 'Professor',
          roles: [{ role: { name: 'ADMIN' } }],
        };
      }
      if (method === 'delete') {
        return { id: args[0]?.where?.id };
      }
    }
    
    if (model === 'pullRequest') {
      if (method === 'count') return 12;
      if (method === 'findMany') {
        return [
          {
            id: 'pr-1',
            githubId: BigInt(1001),
            prNumber: 42,
            title: 'Mock PR: Fix SQL Injection',
            state: 'open',
            status: 'PASS',
            authorLogin: 'tokyo_coder',
            authorAvatarUrl: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&h=80&q=80',
            repositoryId: 'repo-1',
            createdAt: new Date(),
            repository: { id: 'repo-1', githubId: BigInt(123456), fullName: 'mock-owner/mock-repo', owner: 'mock-owner' }
          }
        ];
      }
      if (method === 'groupBy') {
        return [
          { authorLogin: 'tokyo_coder', _count: { _all: 12 } },
          { authorLogin: 'denver_dev', _count: { _all: 8 } },
          { authorLogin: 'helsinki_sec', _count: { _all: 5 } },
        ];
      }
      if (method === 'findFirst') {
        return { authorAvatarUrl: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&h=80&q=80' };
      }
    }
    
    if (model === 'auditLog') {
      if (method === 'count') return 8;
      if (method === 'findMany') {
        if (args[0]?.select?.action) {
          return [
            { action: 'UPDATE_ROLE' },
            { action: 'DELETE_USER' },
            { action: 'ADD_REPO' }
          ];
        }
        return [
          {
            id: 'log-1',
            userId: 'mock-admin-id',
            action: 'UPDATE_ROLE',
            resource: 'user:user-2',
            decision: 'ALLOW',
            metadata: { role: 'ADMIN' },
            timestamp: new Date(),
          },
          {
            id: 'log-2',
            userId: 'mock-admin-id',
            action: 'DELETE_USER',
            resource: 'user:user-3',
            decision: 'ALLOW',
            metadata: {},
            timestamp: new Date(Date.now() - 1000 * 60 * 5),
          }
        ];
      }
      if (method === 'groupBy') {
        return [
          { action: 'UPDATE_ROLE', _count: { _all: 5 } },
          { action: 'DELETE_USER', _count: { _all: 3 } },
        ];
      }
      if (method === 'create') {
        return args[0]?.data || {};
      }
    }
    
    if (model === 'scanResult') {
      if (method === 'count') return 25;
      if (method === 'findMany') {
        return [
          { createdAt: new Date() },
          { createdAt: new Date(Date.now() - 1000 * 3600 * 24) }
        ];
      }
    }
    
    if (model === 'finding') {
      if (method === 'count') {
        const severity = args[0]?.where?.severity;
        if (severity === 'CRITICAL') return 1;
        if (severity === 'HIGH') return 2;
        if (severity === 'MEDIUM') return 4;
        if (severity === 'LOW') return 8;
        return 15;
      }
    }
    
    if (model === 'repository') {
      if (method === 'upsert') {
        return {
          id: 'repo-1',
          githubId: args[0]?.create?.githubId || BigInt(123456),
          fullName: args[0]?.create?.fullName || 'mock-owner/mock-repo',
          owner: args[0]?.create?.owner || 'mock-owner',
          userId: args[0]?.create?.userId || 'mock-admin-id',
        };
      }
    }

    if (model === 'role') {
      if (method === 'upsert') {
        return { id: 'role-1', name: args[0]?.create?.name || 'ADMIN' };
      }
    }

    if (model === 'userRole') {
      if (method === 'deleteMany') return { count: 1 };
      if (method === 'create') return { id: 'ur-1', ...args[0]?.data };
    }
    
    // Generic fallback responses
    if (method === 'count') return 0;
    if (method?.startsWith('findMany') || method === 'groupBy') return [];
    if (method === 'deleteMany') return { count: 0 };
    return { id: 'mock-id' };
  };

  const handler = {
    get(target: any, prop: string): any {
      if (prop === '$transaction') {
        return async (promises: any[]) => Promise.all(promises);
      }
      if (prop === 'then') return undefined;
      
      return new Proxy(() => {}, {
        apply(targetApply, thisArg, argumentsList) {
          return mockFn(prop, '', argumentsList);
        },
        get(targetGet, propGet) {
          if (propGet === 'then') return undefined;
          return new Proxy(() => {}, {
            apply(targetSubApply, thisArgSub, argumentsListSub) {
              return mockFn(prop, propGet as string, argumentsListSub);
            }
          });
        }
      });
    }
  };

  return new Proxy({}, handler);
}

/**
 * The database connection string, preferring a pooler when one is configured.
 *
 * The old implementation had a production-only branch returning
 * `DATABASE_POOL_URL` above a line that already preferred `DATABASE_POOL_URL`
 * unconditionally, so the branch could never change the answer. Resolution now
 * lives in `@/lib/db/pool-config` where it is pure and tested; this signature is
 * kept for the existing callers.
 */
export function getDatabaseConnectionString(): string | undefined {
  return resolveConnectionString() ?? undefined;
}

/**
 * PostgreSQL pool options for a serverless deployment.
 *
 * `DB_POOL_MAX` used to be read with a bare `parseInt`, so `DB_POOL_MAX=abc`
 * reached `new Pool({ max: NaN })` and `DB_POOL_MAX=0` disabled the pool
 * outright. It is clamped now, and an unusable value is reported rather than
 * propagated (#688).
 */
export function getPgPoolConfig(overrideConnectionString?: string): PgPoolConfig {
  const { config } = resolvePoolConfig();
  const { warning } = resolvePoolMax();

  if (warning) log.warn(warning);

  return overrideConnectionString
    ? { ...config, connectionString: overrideConnectionString }
    : config;
}

/**
 * Make an unconfigured pool fail with the reason it is unconfigured.
 *
 * `new Pool({ connectionString: undefined })` does not fail. libpq semantics
 * take over, it tries the local Unix socket as `$USER`, and the deployment
 * eventually reports `role "nextjs" does not exist` — an error about the wrong
 * thing entirely.
 *
 * Overriding the two entry points rather than throwing at construction is
 * deliberate. This module is imported during `next build`, which runs no
 * queries and has no database; failing the build over a connection that is
 * never opened would trade one misleading error for another. The first real
 * query is where the fault actually matters, and that is where it now says so.
 */
function guardUnconfiguredPool(pool: Pool): Pool {
  const refuse = async (): Promise<never> => {
    throw new Error(MISSING_CONNECTION_STRING_MESSAGE);
  };

  pool.connect = refuse as unknown as Pool['connect'];
  pool.query = refuse as unknown as Pool['query'];

  return pool;
}

/**
 * Create the pool and attach the error listener it was missing.
 *
 * `pg.Pool` emits `'error'` when a client sitting **idle in the pool** hits a
 * network-level failure: a Postgres restart, a PgBouncer recycle, an
 * idle-timeout RST from a managed provider. That event is not tied to any
 * in-flight query, so no `try/catch` in the application can see it — and `Pool`
 * is an `EventEmitter`, so an `'error'` with no listener is re-thrown as an
 * uncaught exception and takes the process down.
 *
 * This is the first paragraph of the node-postgres pooling documentation and it
 * was the one thing missing here. The pool discards the failed client and
 * carries on; all this listener has to do is exist, and say what happened.
 */
function createPool(): Pool {
  const { config, unconfigured, warnings } = resolvePoolConfig();

  for (const warning of warnings) log.warn(warning);

  const pool = new Pool(config);

  pool.on('error', (error: Error) => {
    log.error('Idle Postgres client errored; the pool will discard it', { error });
  });

  return unconfigured ? guardUnconfiguredPool(pool) : pool;
}

const prismaClientSingleton = () => {
  const mockDb = resolveMockDb();

  if (mockDb.requested && !mockDb.allowed) {
    // Refused rather than warned: the mock answers `user.findUnique` with a
    // hardcoded ADMIN, so a deployment running on it is not degraded, it is
    // lying about who is signed in.
    log.error(mockDb.refusal ?? 'NEXT_PUBLIC_MOCK_DB refused.');
    throw new Error(mockDb.refusal);
  }

  if (mockDb.allowed) {
    log.warn('Using the in-memory mock database. Every response below is fabricated.');
    return createMockPrismaClient() as any;
  }

  // 1. Initialize a connection pool using the standard pg driver, with the
  //    serverless pooling config and — new — an 'error' listener, without which
  //    an idle-client failure is an uncaught exception (#688).
  const pool = createPool();

  // 2. Wrap the pool in the Prisma pg adapter
  const adapter = new PrismaPg(pool);

  // 3. Pass the adapter to the Prisma Client constructor
  return new PrismaClient({ adapter });
}

declare const globalThis: {
  prismaGlobal: ReturnType<typeof prismaClientSingleton>;
} & typeof global;

const prisma = globalThis.prismaGlobal ?? prismaClientSingleton();

export default prisma;

if (process.env.NODE_ENV !== 'production') globalThis.prismaGlobal = prisma;