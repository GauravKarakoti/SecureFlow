import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

// BigInt serialization fix: standard JSON.stringify() does not support BigInt values.
// Patching BigInt.prototype.toJSON allows objects with BigInt fields (such as Repository/PullRequest githubId)
// to be serialized safely in API responses.
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

(BigInt.prototype as any).toJSON = function () {
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
 * Resolves the database connection string based on environment settings.
 * In production serverless environments, prioritizes DATABASE_POOL_URL (e.g. PgBouncer or Neon connection pooler)
 * to manage connections effectively across multiple serverless function instances.
 * Falls back to DATABASE_URL if DATABASE_POOL_URL is not set.
 */
export function getDatabaseConnectionString(): string | undefined {
  if (process.env.NODE_ENV === 'production' && process.env.DATABASE_POOL_URL) {
    return process.env.DATABASE_POOL_URL;
  }
  return process.env.DATABASE_POOL_URL || process.env.DATABASE_URL;
}

/**
 * Returns PostgreSQL pool options optimized for serverless deployments.
 * Caps the maximum pool size (defaulting to 10 or DB_POOL_MAX env var)
 * and configures idle/connection timeouts to prevent connection exhaustion.
 */
export function getPgPoolConfig(overrideConnectionString?: string) {
  const connectionString = overrideConnectionString || getDatabaseConnectionString();
  const max = process.env.DB_POOL_MAX
    ? parseInt(process.env.DB_POOL_MAX, 10)
    : 10;

  return {
    connectionString,
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };
}

const prismaClientSingleton = () => {
  if (process.env.NEXT_PUBLIC_MOCK_DB === 'true') {
    return createMockPrismaClient() as any;
  }
  // 1. Initialize a connection pool using the standard pg driver with serverless pooling config
  const pool = new Pool(getPgPoolConfig());
  
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