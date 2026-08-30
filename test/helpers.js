"use strict";
/**
 * Shared test rig: boots api/webhook.js behind a local HTTP server with a
 * stubbed OpenAI client and, optionally, a stubbed Redis backend.
 *
 * Each scenario lives in its own file because `lib/conversation.js` and
 * `lib/analytics.js` capture their Redis client at module load, so storage
 * behaviour has to be decided before anything is required. `node --test` runs
 * each file in a separate process, which gives that isolation for free.
 */

const Module = require("module");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const querystring = require("querystring");

const ROOT = path.join(__dirname, "..");

const DEFAULT_COMPLETION =
  "Try 4-7-8 breathing tonight.\n\n" +
  '<<<STATE>>>{"ageRange":"18-24","mainReason":"trouble falling asleep",' +
  '"severity":"pretty chill","branch":"Bedtime Routine","language":"en"}<<<END>>>';

/** Replace the `openai` package with a deterministic stub. */
function stubOpenAI({ content = DEFAULT_COMPLETION, onCall } = {}) {
  const calls = [];
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "openai") {
      return class FakeOpenAI {
        get chat() {
          return {
            completions: {
              create: async (args) => {
                calls.push(args);
                if (onCall) onCall(args);
                return {
                  choices: [{ message: { content } }],
                  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
                };
              },
            },
          };
        }
      };
    }
    return origLoad.call(this, request, ...rest);
  };
  process.env.OPENAI_API_KEY = "sk-test";
  return calls;
}

/** An in-process Redis stand-in implementing the subset the app uses. */
function fakeRedis() {
  const store = new Map();
  return {
    _store: store,
    async get(k) {
      return store.has(k) ? store.get(k) : null;
    },
    async set(k, v) {
      store.set(k, v);
      return "OK";
    },
    async del(k) {
      return store.delete(k) ? 1 : 0;
    },
    async incr(k) {
      const n = (Number(store.get(k)) || 0) + 1;
      store.set(k, n);
      return n;
    },
    async incrby(k, by) {
      const n = (Number(store.get(k)) || 0) + by;
      store.set(k, n);
      return n;
    },
    async mget(...ks) {
      return ks.map((k) => (store.has(k) ? store.get(k) : null));
    },
    async hgetall(k) {
      return store.get("h:" + k) || null;
    },
    async hincrby(k, f, by) {
      const h = store.get("h:" + k) || {};
      h[f] = (Number(h[f]) || 0) + by;
      store.set("h:" + k, h);
      return h[f];
    },
    async sadd(k, m) {
      const s = store.get("s:" + k) || new Set();
      const had = s.has(m);
      s.add(m);
      store.set("s:" + k, s);
      return had ? 0 : 1;
    },
    async smembers(k) {
      return [...(store.get("s:" + k) || [])];
    },
    async lpush(k, v) {
      const l = store.get("l:" + k) || [];
      l.unshift(v);
      store.set("l:" + k, l);
      return l.length;
    },
    async ltrim() {
      return "OK";
    },
    async lrange(k, a, b) {
      return (store.get("l:" + k) || []).slice(a, b + 1);
    },
    async scan() {
      return [0, [...store.keys()].filter((k) => k.startsWith("luna:"))];
    },
    async ping() {
      return "PONG";
    },
  };
}

/**
 * Force the shared client factory to return `client` (or null) before any
 * module requires it.
 */
function stubRedisClient(client) {
  const rc = require(path.join(ROOT, "lib/redis-client.js"));
  rc.createRedisClient = () => client;
  rc.isRedisConfigured = () => Boolean(client);
  return rc;
}

/** Vercel-style response helpers, which plain `http` does not provide. */
function decorate(res) {
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.send = (b) => {
    res.end(b);
    return res;
  };
  res.json = (o) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(o));
    return res;
  };
  return res;
}

function twilioSignature(token, url, params) {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return crypto.createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
}

/** Start the webhook on an ephemeral port. Returns { post, close, url }. */
async function startWebhook() {
  const handler = require(path.join(ROOT, "api/webhook.js"));
  const server = http.createServer((req, res) => handler(req, decorate(res)));
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  const publicUrl = `https://${host}/api/webhook`;

  function post(params, { sign = false, signature } = {}) {
    return new Promise((resolve, reject) => {
      const data = querystring.stringify(params);
      const headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(data),
      };
      if (sign || signature) {
        headers["x-forwarded-proto"] = "https";
        headers["x-forwarded-host"] = host;
        headers["x-twilio-signature"] =
          signature || twilioSignature(process.env.TWILIO_AUTH_TOKEN, publicUrl, params);
      }
      const req = http.request({ port, method: "POST", path: "/api/webhook", headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body,
            messages: [...body.matchAll(/<Message>([\s\S]*?)<\/Message>/g)].map((m) => m[1]),
          })
        );
      });
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  return { post, url: publicUrl, close: () => new Promise((r) => server.close(r)) };
}

// Chosen to survive TwiML's XML escaping (the notice itself contains "&").
const PRIVACY_SNIPPET = "Quick heads-up first";
const isPrivacyNotice = (m) => m.includes(PRIVACY_SNIPPET);

module.exports = {
  ROOT,
  DEFAULT_COMPLETION,
  stubOpenAI,
  stubRedisClient,
  fakeRedis,
  startWebhook,
  twilioSignature,
  isPrivacyNotice,
};
