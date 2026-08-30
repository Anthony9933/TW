"use strict";
/** Storage is healthy and durable: the normal production path. */
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const h = require("./helpers");

h.stubOpenAI();
const redis = h.fakeRedis();
h.stubRedisClient(redis);

const USER = "whatsapp:+15551230001";
const TO = "whatsapp:+16616057191";

let rig;
before(async () => {
  rig = await h.startWebhook();
});
after(async () => {
  await rig.close();
});

test("first contact returns the privacy notice on its own", async () => {
  const res = await rig.post({ From: USER, To: TO, Body: "hey" });
  assert.equal(res.status, 200);
  assert.equal(res.messages.length, 1);
  assert.ok(h.isPrivacyNotice(res.messages[0]));
});

test("the notice is never repeated once storage remembers it", async () => {
  const second = await rig.post({ From: USER, To: TO, Body: "i cant sleep, im 22" });
  const third = await rig.post({ From: USER, To: TO, Body: "any tips?" });
  for (const res of [second, third]) {
    assert.equal(res.status, 200);
    assert.equal(res.messages.length, 1);
    assert.ok(!h.isPrivacyNotice(res.messages[0]), "notice must not repeat");
  }
});

test("history and derived state survive across turns", async () => {
  const conv = require(path.join(h.ROOT, "lib/conversation"));
  const session = await conv.getSession(USER);
  // 3 turns: notice pair + two full exchanges
  assert.equal(session.messages.length, 6);
  assert.equal(session.state.privacyNoticeSent, true);
  assert.equal(session.state.ageRange, "18-24");
  assert.equal(session.state.mainReason, "trouble falling asleep");
  assert.equal(session.state.stage, "tailored");
  // Regression: these used to be discarded because the webhook re-read the
  // session from storage instead of persisting the object it had mutated.
  assert.ok(session.state.conversationCount >= 1, "conversationCount must persist");
  assert.ok(session.state.tipsGiven.length >= 1, "tipsGiven must persist");
});

test("dashboard reports healthy redis storage", async () => {
  const analytics = require(path.join(h.ROOT, "lib/analytics"));
  const snap = await analytics.getDashboardSnapshot();
  assert.equal(snap.storage, "redis");
  assert.equal(snap.storage_healthy, true);
  assert.ok(snap.totals.inbound >= 3);
  assert.ok(snap.totals.outbound >= 3);
});

test("forget me wipes the stored session", async () => {
  const conv = require(path.join(h.ROOT, "lib/conversation"));
  const res = await rig.post({ From: USER, To: TO, Body: "forget me" });
  assert.equal(res.status, 200);
  assert.match(res.messages[0], /wiped/i);
  assert.equal(await conv.getSession(USER), null);
});

test("media-only messages get a text-only explanation, not an empty model turn", async () => {
  const MEDIA_USER = "whatsapp:+15551230002";
  await rig.post({ From: MEDIA_USER, To: TO, Body: "hi" }); // clear the notice
  const res = await rig.post({ From: MEDIA_USER, To: TO, Body: "", NumMedia: "1" });
  assert.equal(res.status, 200);
  assert.match(res.messages[0], /only read text/i);
});

test("a request without a sender is rejected", async () => {
  const res = await rig.post({ To: TO, Body: "hi" });
  assert.equal(res.status, 400);
});
