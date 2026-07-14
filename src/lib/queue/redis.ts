import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

// Use a singleton pattern to avoid multiple connections in Next.js development
const globalForRedis = global as unknown as { redis: Redis };

export const redis = globalForRedis.redis || new Redis(redisUrl, redisOptions);

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
}
