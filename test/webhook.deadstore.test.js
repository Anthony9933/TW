"use strict";
/**
 * Storage is configured but unreachable — the exact production failure: the
 * Redis database had been deleted while its credentials stayed in the
 * environment, so every command hung until the function was killed.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const h = require("./helpers");

process.env.REDIS_TIMEOUT_MS = "300";
process.env.REDIS_BREAKER_THRESHOLD = "3";

h.stubOpenAI();

// A client whose every command never settles, wrapped in the real timeout and
// circuit-breaker logic so we exercise the shipped protection.
const path = require("path");
const rc = require(path.join(h.ROOT, "lib/redis-client.js"));
const hang = new Proxy(
  {},
  {
    get: () => () => new Promise(() => {}),
  }
);
rc.createRedisClient = () => rc.__wrapForTest(hang);
rc.isRedisConfigured = () => true;

const TO = "whatsapp:+16616057191";
let rig;
before(async () => {
  rig = await h.startWebhook();
});
after(async () => {
  await rig.close();
});

test("replies normally instead of hanging or looping the intro", async () => {
  const user = "whatsapp:+15551250001";
  const started = Date.now();

  const first = await rig.post({ From: user, To: TO, Body: "hey" });
  assert.equal(first.status, 200);
  assert.ok(first.messages.length >= 1);

  const second = await rig.post({ From: user, To: TO, Body: "i cant sleep" });
  assert.equal(second.status, 200);
  assert.ok(!second.messages.some(h.isPrivacyNotice), "intro must not repeat");

  const third = await rig.post({ From: user, To: TO, Body: "any tips?" });
  assert.equal(third.status, 200);

  // Without the circuit breaker each request pays the timeout on ~15 sequential
  // commands, which alone exceeds Twilio's webhook budget.
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10000, `three turns took ${elapsed}ms; expected well under 10s`);
});

test("storage health is reported honestly, not as healthy", async () => {
  const analytics = require(path.join(h.ROOT, "lib/analytics"));
  const snap = await analytics.getDashboardSnapshot();
  assert.equal(snap.storage, "redis-unreachable");
  assert.equal(snap.storage_healthy, false);
});
