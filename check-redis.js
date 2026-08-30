#!/usr/bin/env node
/**
 * Redis connection diagnostic.
 *
 * Usage: node check-redis.js
 *
 * Reads .env / .env.local if present (no dependency on `dotenv`), builds the
 * same client the app uses, and runs a real write/read round-trip so a
 * configured-but-dead database is reported as such instead of looking healthy.
 */

const fs = require("fs");
const path = require("path");

// Minimal .env loader — keeps this script dependency-free.
for (const file of [".env", ".env.local"]) {
  const p = path.join(__dirname, file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

const {
  createRedisClient,
  isRedisConfigured,
  findEnvBySuffix,
  OP_TIMEOUT_MS,
} = require("./lib/redis-client");

const mark = (v) => (v ? "✅ set" : "❌ missing");

async function main() {
  console.log("🔍 Checking Redis configuration\n");

  const restUrl =
    findEnvBySuffix("UPSTASH_REDIS_REST_URL") || findEnvBySuffix("KV_REST_API_URL");
  const restToken =
    findEnvBySuffix("UPSTASH_REDIS_REST_TOKEN") || findEnvBySuffix("KV_REST_API_TOKEN");
  const tcpUrl = findEnvBySuffix("REDIS_URL") || findEnvBySuffix("KV_URL");

  console.log("Credentials (exact name or <prefix>_<name>):");
  console.log("  UPSTASH_REDIS_REST_URL / KV_REST_API_URL   :", mark(restUrl));
  console.log("  UPSTASH_REDIS_REST_TOKEN / KV_REST_API_TOKEN:", mark(restToken));
  console.log("  REDIS_URL / KV_URL                          :", mark(tcpUrl));
  console.log("  command timeout                             :", `${OP_TIMEOUT_MS}ms`);

  if (!isRedisConfigured()) {
    console.log("\n❌ No Redis credentials found.");
    console.log("   The app will fall back to in-memory storage, which does not");
    console.log("   survive between serverless invocations.\n");
    console.log("   Set up a database:");
    console.log("     • Vercel → Storage → Create Database → Redis, or");
    console.log("     • https://console.upstash.com (free tier)");
    process.exitCode = 1;
    return;
  }

  const redis = createRedisClient();
  if (!redis) {
    console.log("\n❌ Credentials are present but no client could be built.");
    console.log("   A REST URL must start with https:// and a TCP URL with redis:// or rediss://");
    process.exitCode = 1;
    return;
  }

  console.log(`\nTransport: ${restUrl && restToken ? "Upstash REST (HTTP)" : "Redis TCP (ioredis)"}`);
  console.log("Testing round-trip…\n");

  try {
    await redis.set("luna:healthcheck", "pong", { ex: 30 });
    console.log("✅ write");
    const val = await redis.get("luna:healthcheck");
    console.log("✅ read  :", val);
  } catch (err) {
    console.error("\n❌ Redis is configured but not responding:", err.message);
    console.error("\n   In this state the chatbot cannot remember conversations and");
    console.error("   will repeat its intro message on every incoming message.");
    console.error("   Most common cause: the database was deleted or its integration");
    console.error("   was uninstalled, while its credentials remain in the environment.");
    process.exitCode = 1;
    return;
  }

  try {
    const [inbound, outbound, errors] = await redis.mget(
      "sw:totals:inbound",
      "sw:totals:outbound",
      "sw:totals:errors"
    );
    console.log("\n📊 Analytics totals");
    console.log("   inbound :", Number(inbound) || 0);
    console.log("   outbound:", Number(outbound) || 0);
    console.log("   errors  :", Number(errors) || 0);
  } catch (err) {
    console.error("\n⚠️  Could not read analytics counters:", err.message);
  }

  console.log("\n✅ Redis is working.");
}

main()
  .catch((err) => {
    console.error("\n❌ Unexpected failure:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    // ioredis keeps the event loop alive; nothing else needs the process.
    setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
  });
