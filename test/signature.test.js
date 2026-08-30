"use strict";
/** Twilio request signing. Without it the webhook is an open endpoint. */
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const h = require("./helpers");

process.env.TWILIO_AUTH_TOKEN = "test_auth_token_0123456789";

h.stubOpenAI();
h.stubRedisClient(h.fakeRedis());

const TO = "whatsapp:+16616057191";
const USER = "whatsapp:+15551260001";
let rig;
before(async () => {
  rig = await h.startWebhook();
});
after(async () => {
  await rig.close();
});

test("an unsigned request is rejected", async () => {
  const res = await rig.post({ From: USER, To: TO, Body: "hey" });
  assert.equal(res.status, 403);
});

test("a forged signature is rejected", async () => {
  const res = await rig.post({ From: USER, To: TO, Body: "hey" }, { signature: "bogus" });
  assert.equal(res.status, 403);
});

test("a signature over different parameters is rejected", async () => {
  const signature = h.twilioSignature(process.env.TWILIO_AUTH_TOKEN, rig.url, {
    From: USER,
    To: TO,
    Body: "something else",
  });
  const res = await rig.post({ From: USER, To: TO, Body: "hey" }, { signature });
  assert.equal(res.status, 403);
});

test("a correctly signed request is accepted", async () => {
  const res = await rig.post({ From: USER, To: TO, Body: "hey" }, { sign: true });
  assert.equal(res.status, 200);
  assert.ok(h.isPrivacyNotice(res.messages[0]));
});

test("validation can be disabled explicitly for local testing", async () => {
  process.env.TWILIO_VALIDATE_SIGNATURE = "false";
  const res = await rig.post({ From: "whatsapp:+15551260002", To: TO, Body: "hey" });
  assert.equal(res.status, 200);
  delete process.env.TWILIO_VALIDATE_SIGNATURE;
});
