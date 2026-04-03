/**
 * Usage & analytics for SleepWell+ Luna (Redis + in-memory fallback).
 */

const crypto = require("crypto");

const PREFIX = "sw";
const MAX_EVENTS = 100;

function getRedis() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = require("@upstash/redis");
    return new Redis({ url, token });
  } catch {
    return null;
  }
}

const redis = getRedis();

const memory = {
  totals: {
    inbound: 0,
    outbound: 0,
    errors: 0,
    forget_me: 0,
    openai_tokens: 0,
  },
  daily: new Map(),
  usersByDay: new Map(),
  events: [],
};

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function hashUser(phone) {
  const raw = String(phone || "").replace(/\D/g, "");
  if (!raw) return "unknown";
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function bumpMemoryDaily(field, extra = {}) {
  const k = dayKey();
  const o = memory.daily.get(k) || {
    inbound: 0,
    outbound: 0,
    errors: 0,
    forget_me: 0,
    openai_tokens: 0,
  };
  if (field) o[field] = (o[field] || 0) + 1;
  if (extra.openai_tokens)
    o.openai_tokens = (o.openai_tokens || 0) + extra.openai_tokens;
  memory.daily.set(k, o);
}

function trackUserDay(h) {
  const k = dayKey();
  if (!memory.usersByDay.has(k)) memory.usersByDay.set(k, new Set());
  memory.usersByDay.get(k).add(h);
}

function pushEvent(type, userHash, meta = {}) {
  memory.events.unshift({
    ts: Date.now(),
    type,
    user: userHash,
    ...meta,
  });
  memory.events.length = Math.min(memory.events.length, MAX_EVENTS);
}

async function redisIncr(key) {
  if (!redis) return;
  try {
    await redis.incr(key);
  } catch (e) {
    console.error("[analytics] incr", key, e);
  }
}

async function redisIncrby(key, by) {
  if (!redis || !by) return;
  try {
    await redis.incrby(key, by);
  } catch (e) {
    console.error("[analytics] incrby", key, e);
  }
}

async function redisHincrby(hashKey, field, by = 1) {
  if (!redis) return;
  try {
    await redis.hincrby(hashKey, field, by);
  } catch (e) {
    console.error("[analytics] hincrby", hashKey, e);
  }
}

async function redisSadd(setKey, member) {
  if (!redis) return;
  try {
    await redis.sadd(setKey, member);
  } catch (e) {
    console.error("[analytics] sadd", setKey, e);
  }
}

async function redisLpushEvent(payload) {
  if (!redis) return;
  try {
    await redis.lpush(`${PREFIX}:events`, JSON.stringify(payload));
    await redis.ltrim(`${PREFIX}:events`, 0, MAX_EVENTS - 1);
  } catch (e) {
    console.error("[analytics] lpush events", e);
  }
}

/**
 * Record inbound user message.
 */
async function recordInbound(from) {
  const h = hashUser(from);
  memory.totals.inbound += 1;
  bumpMemoryDaily("inbound");
  trackUserDay(h);

  await redisIncr(`${PREFIX}:totals:inbound`);
  await redisHincrby(`${PREFIX}:day:${dayKey()}`, "inbound", 1);
  await redisSadd(`${PREFIX}:users:${dayKey()}`, h);

  pushEvent("inbound", h, {});
  await redisLpushEvent({ ts: Date.now(), type: "inbound", user: h });
}

/**
 * Record outbound assistant message (after successful OpenAI call).
 */
async function recordOutbound(from, usage = null) {
  const h = hashUser(from);
  const tokens = usage?.total_tokens || 0;

  memory.totals.outbound += 1;
  bumpMemoryDaily("outbound", tokens ? { openai_tokens: tokens } : {});
  if (tokens) memory.totals.openai_tokens += tokens;

  await redisIncr(`${PREFIX}:totals:outbound`);
  await redisHincrby(`${PREFIX}:day:${dayKey()}`, "outbound", 1);
  if (tokens) {
    await redisIncrby(`${PREFIX}:totals:openai_tokens`, tokens);
    await redisHincrby(`${PREFIX}:day:${dayKey()}`, "openai_tokens", tokens);
  }

  pushEvent("outbound", h, { tokens: tokens || undefined });
  await redisLpushEvent({
    ts: Date.now(),
    type: "outbound",
    user: h,
    tokens: tokens || undefined,
  });
}

async function recordError(from) {
  const h = hashUser(from);
  memory.totals.errors += 1;
  bumpMemoryDaily("errors");
  pushEvent("error", h, {});

  await redisIncr(`${PREFIX}:totals:errors`);
  await redisHincrby(`${PREFIX}:day:${dayKey()}`, "errors", 1);
  await redisLpushEvent({ ts: Date.now(), type: "error", user: h });
}

async function recordForgetMe(from) {
  const h = hashUser(from);
  memory.totals.forget_me += 1;
  bumpMemoryDaily("forget_me");
  pushEvent("forget_me", h, {});

  await redisIncr(`${PREFIX}:totals:forget_me`);
  await redisHincrby(`${PREFIX}:day:${dayKey()}`, "forget_me", 1);
  await redisLpushEvent({ ts: Date.now(), type: "forget_me", user: h });
}

async function getTotalsFromRedis() {
  if (!redis) return null;
  try {
    const keys = [
      `${PREFIX}:totals:inbound`,
      `${PREFIX}:totals:outbound`,
      `${PREFIX}:totals:errors`,
      `${PREFIX}:totals:forget_me`,
      `${PREFIX}:totals:openai_tokens`,
    ];
    const vals = await redis.mget(...keys);
    const [inbound, outbound, errors, forget, tok] = vals || [];
    return {
      inbound: Number(inbound) || 0,
      outbound: Number(outbound) || 0,
      errors: Number(errors) || 0,
      forget_me: Number(forget) || 0,
      openai_tokens: Number(tok) || 0,
    };
  } catch (e) {
    console.error("[analytics] getTotals", e);
    return null;
  }
}

async function getDaySeries(days = 14) {
  const series = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    let inbound = 0;
    let outbound = 0;
    let errors = 0;
    let openai_tokens = 0;

    if (redis) {
      try {
        const h = await redis.hgetall(`${PREFIX}:day:${key}`);
        if (h && typeof h === "object") {
          inbound = Number(h.inbound) || 0;
          outbound = Number(h.outbound) || 0;
          errors = Number(h.errors) || 0;
          openai_tokens = Number(h.openai_tokens) || 0;
        }
      } catch (e) {
        console.error("[analytics] getDaySeries", key, e);
      }
    } else {
      const m = memory.daily.get(key);
      if (m) {
        inbound = m.inbound || 0;
        outbound = m.outbound || 0;
        errors = m.errors || 0;
        openai_tokens = m.openai_tokens || 0;
      }
    }

    series.push({
      date: key,
      label: d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      inbound,
      outbound,
      errors,
      openai_tokens,
    });
  }
  return series;
}

async function getUniqueUsersLastDays(days = 7) {
  const now = new Date();
  const seen = new Set();

  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dk = dayKey(d);

    if (redis) {
      try {
        const members = await redis.smembers(`${PREFIX}:users:${dk}`);
        if (Array.isArray(members)) {
          for (const m of members) seen.add(m);
        }
      } catch (e) {
        console.error("[analytics] smembers", dk, e);
      }
    } else {
      const set = memory.usersByDay.get(dk);
      if (set) for (const h of set) seen.add(h);
    }
  }

  return { unique_users_7d: seen.size };
}

async function countActiveSessions() {
  if (!redis) return null;
  try {
    let cursor = 0;
    let count = 0;
    do {
      const result = await redis.scan(cursor, {
        match: "luna:*",
        count: 200,
      });
      const next = Array.isArray(result) ? result[0] : result?.[0];
      const keys = Array.isArray(result) ? result[1] : result?.[1];
      cursor = Number(next);
      count += Array.isArray(keys) ? keys.length : 0;
    } while (cursor !== 0);
    return count;
  } catch (e) {
    console.error("[analytics] scan sessions", e);
    return null;
  }
}

async function getRecentEvents(limit = 50) {
  if (redis) {
    try {
      const raw = await redis.lrange(`${PREFIX}:events`, 0, limit - 1);
      if (Array.isArray(raw)) {
        return raw
          .map((s) => {
            try {
              return typeof s === "string" ? JSON.parse(s) : s;
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      }
    } catch (e) {
      console.error("[analytics] lrange events", e);
    }
  }
  return memory.events.slice(0, limit);
}

/** Rough USD estimate for gpt-4o-mini (blended input/output). */
function estimateCostUsd(tokens) {
  if (!tokens) return 0;
  return (tokens / 1_000_000) * 0.25;
}

/**
 * Snapshot for dashboard API.
 */
async function getDashboardSnapshot() {
  const redisTotals = await getTotalsFromRedis();
  const totals = redisTotals || { ...memory.totals };

  const series = await getDaySeries(14);
  const { unique_users_7d } = await getUniqueUsersLastDays(7);
  const activeSessions = await countActiveSessions();
  const recent = await getRecentEvents(40);

  const todayKey = dayKey();
  const today =
    series.find((s) => s.date === todayKey) || {
      inbound: 0,
      outbound: 0,
      errors: 0,
      openai_tokens: 0,
    };

  return {
    generated_at: new Date().toISOString(),
    totals: {
      ...totals,
      estimated_openai_cost_usd: estimateCostUsd(totals.openai_tokens || 0),
    },
    today,
    series_14d: series,
    unique_users_7d,
    active_sessions_redis: activeSessions,
    recent_events: recent,
    storage: redis ? "redis" : "memory",
  };
}

module.exports = {
  recordInbound,
  recordOutbound,
  recordError,
  recordForgetMe,
  getDashboardSnapshot,
  hashUser,
};
