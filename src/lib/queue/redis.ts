import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

// Use a singleton pattern to avoid multiple connections in Next.js development
const globalForRedis = global as unknown as { redis: any };

export const redis = globalForRedis.redis || (
  process.env.NEXT_PUBLIC_MOCK_DB === 'true'
    ? {
        on: () => {},
        info: async () => 'redis_version:6.2.6',
        get: async () => null,
        set: async () => 'OK',
        del: async () => 1,
      } as any
    : new Redis(redisUrl, redisOptions)
);

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
}
