/**
 * Unified Redis client supporting both Upstash REST API and traditional Redis.
 *
 * Supported formats:
 * - Upstash: UPSTASH_REDIS_REST_URL (https://...) + UPSTASH_REDIS_REST_TOKEN
 * - Vercel KV: KV_REST_API_URL (https://...) + KV_REST_API_TOKEN
 * - Redis Labs/Traditional: REDIS_URL (redis://...)
 */

/**
 * Creates a Redis client that works with both Upstash and traditional Redis.
 * Returns a unified interface with common Redis commands.
 */
function createRedisClient() {
  // Check for Upstash REST API credentials (preferred)
  const upstashUrl =
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const upstashToken =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

  if (upstashUrl && upstashToken) {
    try {
      const { Redis } = require("@upstash/redis");
      return new Redis({ url: upstashUrl, token: upstashToken });
    } catch (err) {
      console.error("[redis] Failed to create Upstash client:", err.message);
    }
  }

  // Check for traditional Redis URL (redis://)
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl && redisUrl.startsWith("redis://")) {
    try {
      const IORedis = require("ioredis");
      const client = new IORedis(redisUrl, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: true,
      });

      // Wrap ioredis to match Upstash's API
      return createIORedisWrapper(client);
    } catch (err) {
      console.error("[redis] Failed to create ioredis client:", err.message);
    }
  }

  return null;
}

/**
 * Wraps ioredis to match Upstash Redis API.
 * Upstash returns raw values, ioredis returns Buffers/strings.
 */
function createIORedisWrapper(ioredisClient) {
  // Connect on first use
  let connected = false;
  async function ensureConnected() {
    if (!connected) {
      await ioredisClient.connect();
      connected = true;
    }
  }

  return {
    // Basic operations
    async get(key) {
      await ensureConnected();
      const val = await ioredisClient.get(key);
      if (val === null) return null;
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    },

    async set(key, value, options = {}) {
      await ensureConnected();
      const serialized = typeof value === "string" ? value : JSON.stringify(value);
      if (options.ex) {
        await ioredisClient.setex(key, options.ex, serialized);
      } else {
        await ioredisClient.set(key, serialized);
      }
      return "OK";
    },

    async del(...keys) {
      await ensureConnected();
      return await ioredisClient.del(...keys);
    },

    async incr(key) {
      await ensureConnected();
      return await ioredisClient.incr(key);
    },

    async incrby(key, increment) {
      await ensureConnected();
      return await ioredisClient.incrby(key, increment);
    },

    async mget(...keys) {
      await ensureConnected();
      const vals = await ioredisClient.mget(...keys);
      return vals.map((v) => {
        if (v === null) return null;
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      });
    },

    // Hash operations
    async hgetall(key) {
      await ensureConnected();
      const hash = await ioredisClient.hgetall(key);
      if (!hash || Object.keys(hash).length === 0) return null;
      // ioredis returns object with string values
      const result = {};
      for (const [k, v] of Object.entries(hash)) {
        try {
          result[k] = JSON.parse(v);
        } catch {
          result[k] = v;
        }
      }
      return result;
    },

    async hincrby(key, field, increment) {
      await ensureConnected();
      return await ioredisClient.hincrby(key, field, increment);
    },

    // Set operations
    async sadd(key, ...members) {
      await ensureConnected();
      return await ioredisClient.sadd(key, ...members);
    },

    async smembers(key) {
      await ensureConnected();
      return await ioredisClient.smembers(key);
    },

    // List operations
    async lpush(key, ...values) {
      await ensureConnected();
      const serialized = values.map((v) =>
        typeof v === "string" ? v : JSON.stringify(v)
      );
      return await ioredisClient.lpush(key, ...serialized);
    },

    async ltrim(key, start, stop) {
      await ensureConnected();
      return await ioredisClient.ltrim(key, start, stop);
    },

    async lrange(key, start, stop) {
      await ensureConnected();
      const vals = await ioredisClient.lrange(key, start, stop);
      return vals.map((v) => {
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      });
    },

    // Scan operation
    async scan(cursor, options = {}) {
      await ensureConnected();
      const match = options.match || "*";
      const count = options.count || 10;
      const result = await ioredisClient.scan(
        cursor,
        "MATCH",
        match,
        "COUNT",
        count
      );
      // ioredis returns [cursor, keys]
      return result;
    },

    // Utility
    async ping() {
      await ensureConnected();
      return await ioredisClient.ping();
    },
  };
}

module.exports = {
  createRedisClient,
};
