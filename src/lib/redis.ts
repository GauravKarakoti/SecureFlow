import Redis from 'ioredis';

const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};

// Use an in-memory fallback if UPSTASH_REDIS_REST_URL is not provided (useful for local dev without Docker)
let redisInstance: Redis | null = null;

if (process.env.UPSTASH_REDIS_REST_URL) {
  redisInstance =
    globalForRedis.redis ??
    new Redis(process.env.UPSTASH_REDIS_REST_URL, {
      maxRetriesPerRequest: 3,
    });
    
  if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redisInstance;
} else {
  console.warn('⚠️ UPSTASH_REDIS_REST_URL is not set. Rate limiting will fall back to an in-memory Map (not suitable for production multi-instance).');
}

export const redis = redisInstance;

// Basic in-memory fallback for rate limiting if Redis isn't configured
const memoryStore = new Map<string, { count: number, resetAt: number }>();

export async function checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const now = Date.now();
  
  if (redis) {
    try {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.expire(key, windowSeconds);
      }
      return current <= limit;
    } catch (error) {
      console.error('Redis error during rate limiting:', error);
      // Fail open to avoid blocking legitimate traffic if Redis goes down
      return true; 
    }
  } else {
    // In-memory fallback logic
    const record = memoryStore.get(key);
    if (!record || record.resetAt < now) {
      memoryStore.set(key, { count: 1, resetAt: now + (windowSeconds * 1000) });
      return true;
    }
    
    if (record.count < limit) {
      record.count += 1;
      return true;
    }
    
    return false;
  }
}
