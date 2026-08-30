"use strict";
/**
 * No durable storage configured.
 *
 * Regression test for the bug that took the deployed bot down: with no store
 * that survives between invocations, every message looked like first contact,
 * so the bot replied with its intro forever and never actually answered.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const h = require("./helpers");

h.stubOpenAI();
h.stubRedisClient(null);

const TO = "whatsapp:+16616057191";
let rig;
before(async () => {
  rig = await h.startWebhook();
});
after(async () => {
  await rig.close();
});

test("first contact delivers the notice AND a real answer", async () => {
  const res = await rig.post({ From: "whatsapp:+15551240001", To: TO, Body: "hey" });
  assert.equal(res.status, 200);
  assert.equal(res.messages.length, 2, "notice plus answer");
  assert.ok(h.isPrivacyNotice(res.messages[0]));
  assert.ok(!h.isPrivacyNotice(res.messages[1]));
});

test("the conversation always progresses instead of looping the intro", async () => {
  const user = "whatsapp:+15551240002";
  const first = await rig.post({ From: user, To: TO, Body: "hey" });
  assert.ok(h.isPrivacyNotice(first.messages[0]));

  for (const body of ["i cant sleep", "any tips?", "thanks"]) {
    const res = await rig.post({ From: user, To: TO, Body: body });
    assert.equal(res.status, 200);
    assert.ok(
      !res.messages.some(h.isPrivacyNotice),
      `intro must not repeat (message: ${body})`
    );
  }
});
