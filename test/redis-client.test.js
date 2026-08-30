"use strict";
/** The timeout + circuit-breaker wrapper that keeps a dead backend survivable. */
const { test, beforeEach } = require("node:test");
const assert = require("node:assert");

process.env.REDIS_TIMEOUT_MS = "200";
process.env.REDIS_BREAKER_THRESHOLD = "3";
process.env.REDIS_BREAKER_COOLDOWN_MS = "1000";

const { __wrapForTest, resetBreaker } = require("../lib/redis-client");

beforeEach(() => resetBreaker());

test("a hanging command rejects instead of hanging forever", async () => {
  const client = __wrapForTest({ get: () => new Promise(() => {}) });
  const started = Date.now();
  await assert.rejects(() => client.get("k"), /timed out/);
  assert.ok(Date.now() - started < 1000);
});

test("a healthy command passes its value through", async () => {
  const client = __wrapForTest({ get: async () => "value" });
  assert.equal(await client.get("k"), "value");
});

test("repeated failures open the circuit so later calls fail immediately", async () => {
  const client = __wrapForTest({ get: () => new Promise(() => {}) });
  for (let i = 0; i < 3; i++) await assert.rejects(() => client.get("k"));

  const started = Date.now();
  await assert.rejects(() => client.get("k"), /circuit open/);
  assert.ok(Date.now() - started < 50, "an open circuit must not wait for a timeout");
});

test("a success resets the failure count", async () => {
  let fail = true;
  const client = __wrapForTest({
    get: () => (fail ? Promise.reject(new Error("boom")) : Promise.resolve("ok")),
  });
  await assert.rejects(() => client.get("k"));
  await assert.rejects(() => client.get("k"));
  fail = false;
  assert.equal(await client.get("k"), "ok");
  fail = true;
  // Counter was reset, so two more failures must not be enough to trip it.
  await assert.rejects(() => client.get("k"), /boom/);
  await assert.rejects(() => client.get("k"), /boom/);
});
