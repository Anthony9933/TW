/**
 * Unified Redis client supporting both Upstash REST API and traditional Redis.
 *
 * Supported configurations (first match wins):
 * - Upstash REST : UPSTASH_REDIS_REST_URL (https://...) + UPSTASH_REDIS_REST_TOKEN
 * - Vercel KV     : KV_REST_API_URL (https://...) + KV_REST_API_TOKEN
 * - Redis TCP     : REDIS_URL / KV_URL (redis:// or rediss://)
 *
 * Vercel Marketplace integrations prefix the injected variables with the
 * database name (e.g. `luna_KV_REST_API_URL`), so every lookup matches both the
 * bare name and any `<prefix>_<suffix>` variant.
 *
 * Every command is wrapped in a hard timeout. Without one, an unreachable
 * backend (a deleted database whose credentials are still configured) makes
 * each call hang until the serverless function is killed — which silently
 * bricks the whole app instead of degrading to the in-memory fallback.
 */

const OP_TIMEOUT_MS = Math.max(
  250,
  parseInt(process.env.REDIS_TIMEOUT_MS || "3000", 10) || 3000
);

/** Resolve an env var by exact name, else by `<prefix>_<suffix>`. */
function findEnvBySuffix(suffix) {
  if (process.env[suffix]) return process.env[suffix];
  const key = Object.keys(process.env).find(
    (k) => k.endsWith(`_${suffix}`) && process.env[k]
  );
  return key ? process.env[key] : undefined;
}

/** Reject after `ms` so a dead backend fails fast instead of hanging. */
function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[redis] ${label} timed out after ${OP_TIMEOUT_MS}ms`)),
      OP_TIMEOUT_MS
    );
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() =>
    clearTimeout(timer)
  );
}

// Circuit breaker. A single request path issues dozens of Redis commands
// (analytics alone makes ~15 sequential calls per message). If the backend is
// down, paying OP_TIMEOUT_MS for every one of them blows the serverless
// function's time budget even though each individual call now fails fast. After
// a few consecutive failures we stop trying until the cooldown elapses.
const BREAKER_THRESHOLD = Math.max(
  1,
  parseInt(process.env.REDIS_BREAKER_THRESHOLD || "3", 10) || 3
);
const BREAKER_COOLDOWN_MS = Math.max(
  1000,
  parseInt(process.env.REDIS_BREAKER_COOLDOWN_MS || "30000", 10) || 30000
);

const breaker = { failures: 0, openUntil: 0 };

function breakerIsOpen() {
  if (breaker.openUntil && Date.now() < breaker.openUntil) return true;
  if (breaker.openUntil && Date.now() >= breaker.openUntil) {
    // Cooldown elapsed — allow one probe through.
    breaker.openUntil = 0;
    breaker.failures = 0;
  }
  return false;
}

function recordSuccess() {
  breaker.failures = 0;
  breaker.openUntil = 0;
}

function recordFailure() {
  breaker.failures += 1;
  if (breaker.failures >= BREAKER_THRESHOLD && !breaker.openUntil) {
    breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    console.error(
      `[redis] circuit opened after ${breaker.failures} consecutive failures; ` +
        `skipping Redis for ${BREAKER_COOLDOWN_MS}ms`
    );
  }
}

/** Test hook: reset breaker state. */
function resetBreaker() {
  breaker.failures = 0;
  breaker.openUntil = 0;
}

/**
 * Wrap a client so every method call is bounded by OP_TIMEOUT_MS and guarded by
 * the circuit breaker. Keeps the same surface, so callers are unchanged.
 */
function withTimeouts(client) {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args) => {
        if (breakerIsOpen()) {
          return Promise.reject(
            new Error(`[redis] circuit open, skipping ${String(prop)}`)
          );
        }
        let result;
        try {
          result = value.apply(target, args);
        } catch (err) {
          recordFailure();
          return Promise.reject(err);
        }
        if (!result || typeof result.then !== "function") {
          recordSuccess();
          return result;
        }
        return withTimeout(result, String(prop)).then(
          (v) => {
            recordSuccess();
            return v;
          },
          (err) => {
            recordFailure();
            throw err;
          }
        );
      };
    },
  });
}

/**
 * Creates a Redis client that works with both Upstash and traditional Redis.
 * Returns a unified interface with common Redis commands, or null when no
 * credentials are configured.
 */
function createRedisClient() {
  // Upstash / Vercel KV REST API (preferred — HTTP-based, ideal for serverless)
  const upstashUrl =
    findEnvBySuffix("UPSTASH_REDIS_REST_URL") || findEnvBySuffix("KV_REST_API_URL");
  const upstashToken =
    findEnvBySuffix("UPSTASH_REDIS_REST_TOKEN") || findEnvBySuffix("KV_REST_API_TOKEN");

  if (upstashUrl && upstashToken && /^https?:\/\//i.test(upstashUrl)) {
    try {
      const { Redis } = require("@upstash/redis");
      // Retry once, briefly. The default backoff can stack into tens of
      // seconds, which is longer than the function is allowed to live.
      const client = new Redis({
        url: upstashUrl,
        token: upstashToken,
        retry: { retries: 1, backoff: () => 100 },
      });
      return withTimeouts(client);
    } catch (err) {
      console.error("[redis] Failed to create Upstash client:", err.message);
    }
  }

  // Traditional Redis over TCP. `rediss://` is TLS and is what most managed
  // providers (Redis Cloud, Upstash TCP, Vercel Marketplace Redis) hand out.
  const redisUrl = findEnvBySuffix("REDIS_URL") || findEnvBySuffix("KV_URL");
  if (redisUrl && /^rediss?:\/\//i.test(redisUrl)) {
    try {
      const IORedis = require("ioredis");
      const client = new IORedis(redisUrl, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
        lazyConnect: true,
        connectTimeout: OP_TIMEOUT_MS,
        commandTimeout: OP_TIMEOUT_MS,
        // Serverless: never queue commands behind a connection that may never
        // come up, and never retry forever.
        enableOfflineQueue: false,
        retryStrategy: (times) => (times > 2 ? null : 200),
      });
      client.on("error", (err) => {
        console.error("[redis] connection error:", err.message);
      });
      return withTimeouts(createIORedisWrapper(client));
    } catch (err) {
      console.error("[redis] Failed to create ioredis client:", err.message);
    }
  }

  return null;
}

/**
 * True when Redis credentials are present in the environment. Distinguishes
 * "no Redis configured" (fine, use memory) from "Redis configured but broken"
 * (needs to be surfaced loudly).
 */
function isRedisConfigured() {
  return Boolean(
    (findEnvBySuffix("UPSTASH_REDIS_REST_URL") || findEnvBySuffix("KV_REST_API_URL")) ||
      findEnvBySuffix("REDIS_URL") ||
      findEnvBySuffix("KV_URL")
  );
}

/**
 * Wraps ioredis to match Upstash Redis API.
 * Upstash returns parsed values, ioredis returns strings.
 */
function createIORedisWrapper(ioredisClient) {
  // Connect on first use
  let connecting = null;
  async function ensureConnected() {
    if (ioredisClient.status === "ready") return;
    if (!connecting) {
      connecting = ioredisClient.connect().catch((err) => {
        connecting = null;
        throw err;
      });
    }
    await connecting;
  }

  const parse = (v) => {
    if (v === null || v === undefined) return null;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };

  return {
    // Basic operations
    async get(key) {
      await ensureConnected();
      return parse(await ioredisClient.get(key));
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
      return vals.map(parse);
    },

    // Hash operations
    async hgetall(key) {
      await ensureConnected();
      const hash = await ioredisClient.hgetall(key);
      if (!hash || Object.keys(hash).length === 0) return null;
      const result = {};
      for (const [k, v] of Object.entries(hash)) result[k] = parse(v);
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
      return vals.map(parse);
    },

    // Scan operation
    async scan(cursor, options = {}) {
      await ensureConnected();
      const match = options.match || "*";
      const count = options.count || 10;
      // ioredis returns [cursor, keys] — same shape Upstash returns.
      return await ioredisClient.scan(cursor, "MATCH", match, "COUNT", count);
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
  resetBreaker,
  // Exposed so tests can exercise the timeout + circuit-breaker wrapper
  // against a deliberately unresponsive client.
  __wrapForTest: withTimeouts,
  isRedisConfigured,
  findEnvBySuffix,
  OP_TIMEOUT_MS,
};
