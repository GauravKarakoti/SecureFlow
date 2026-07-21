import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('./prisma');
vi.unmock('@/lib/prisma');

import { getDatabaseConnectionString, getPgPoolConfig } from './prisma';

describe('Prisma Connection Pooling Configuration', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('getDatabaseConnectionString', () => {
    it('returns DATABASE_POOL_URL in production environment if set', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('DATABASE_POOL_URL', 'postgresql://user:pass@pooler.neon.tech/db');
      vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@direct.neon.tech/db');

      expect(getDatabaseConnectionString()).toBe('postgresql://user:pass@pooler.neon.tech/db');
    });

    it('falls back to DATABASE_URL in production if DATABASE_POOL_URL is not set', () => {
      vi.stubEnv('NODE_ENV', 'production');
      delete process.env.DATABASE_POOL_URL;
      vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@direct.neon.tech/db');

      expect(getDatabaseConnectionString()).toBe('postgresql://user:pass@direct.neon.tech/db');
    });

    it('returns DATABASE_POOL_URL in non-production if set', () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('DATABASE_POOL_URL', 'postgresql://user:pass@pooler.neon.tech/db');

      expect(getDatabaseConnectionString()).toBe('postgresql://user:pass@pooler.neon.tech/db');
    });

    it('returns DATABASE_URL in development when DATABASE_POOL_URL is unset', () => {
      vi.stubEnv('NODE_ENV', 'development');
      delete process.env.DATABASE_POOL_URL;
      vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/secureflow');

      expect(getDatabaseConnectionString()).toBe('postgresql://user:pass@localhost:5432/secureflow');
    });
  });

  describe('getPgPoolConfig', () => {
    it('uses default serverless pool max of 10 and timeout options', () => {
      vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/secureflow');
      delete process.env.DB_POOL_MAX;

      const config = getPgPoolConfig();
      expect(config.connectionString).toBe('postgresql://user:pass@localhost:5432/secureflow');
      expect(config.max).toBe(10);
      expect(config.idleTimeoutMillis).toBe(30000);
      expect(config.connectionTimeoutMillis).toBe(10000);
    });

    it('respects DB_POOL_MAX override from environment', () => {
      vi.stubEnv('DB_POOL_MAX', '5');
      vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/secureflow');

      const config = getPgPoolConfig();
      expect(config.max).toBe(5);
    });

    it('allows overriding connection string directly', () => {
      const customString = 'postgresql://custom:secret@customhost:5432/customdb';
      const config = getPgPoolConfig(customString);

      expect(config.connectionString).toBe(customString);
    });
  });
});
