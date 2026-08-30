"use strict";
/** Pure unit tests for reply parsing and state extraction — no I/O. */
const { test } = require("node:test");
const assert = require("node:assert");
const {
  parseReplyAndState,
  stateUpdateFromMeta,
  extractStateFromMessages,
} = require("../lib/conversation");

const EMPTY = { branchesVisited: [], stage: "entry" };

test("splits the hidden state block off the user-facing reply", () => {
  const raw =
    'Sleep well!\n\n<<<STATE>>>{"ageRange":"18-24","language":"en"}<<<END>>>';
  const { visibleReply, meta } = parseReplyAndState(raw);
  assert.equal(visibleReply, "Sleep well!");
  assert.equal(meta.ageRange, "18-24");
});

test("a reply with no state block is passed through untouched", () => {
  const { visibleReply, meta } = parseReplyAndState("Just a reply.");
  assert.equal(visibleReply, "Just a reply.");
  assert.equal(meta, null);
});

test("malformed state metadata never reaches the user", () => {
  const { visibleReply, meta } = parseReplyAndState("Hi<<<STATE>>>{not json}<<<END>>>");
  assert.equal(visibleReply, "Hi");
  assert.equal(meta, null);
});

test("non-string input is handled", () => {
  assert.deepEqual(parseReplyAndState(null), { visibleReply: "", meta: null });
});

test("only whitelisted metadata values are accepted", () => {
  const update = stateUpdateFromMeta(
    { ageRange: "150+", mainReason: "aliens", severity: "catastrophic" },
    EMPTY
  );
  assert.equal(update, null, "garbage must not pollute state");
});

test("valid metadata advances the conversation stage", () => {
  const update = stateUpdateFromMeta(
    {
      ageRange: "25-35",
      mainReason: "anxiety or racing thoughts",
      severity: "making life hard",
      branch: "Racing Mind",
    },
    EMPTY
  );
  assert.equal(update.stage, "tailored");
  assert.deepEqual(update.branchesVisited, ["Racing Mind"]);
});

test("metadata carries language across non-English conversations", () => {
  const update = stateUpdateFromMeta({ language: "ar" }, EMPTY);
  assert.equal(update.language, "ar");
  assert.equal(stateUpdateFromMeta({ language: "klingon" }, EMPTY), null);
});

test("English keyword fallback still classifies age and reason", () => {
  const update = extractStateFromMessages("im 22 and i cant sleep", "", EMPTY);
  assert.equal(update.ageRange, "18-24");
  assert.equal(update.mainReason, "trouble falling asleep");
});

test("times are not mistaken for ages", () => {
  const update = extractStateFromMessages("i go to bed at 11 pm", "", EMPTY);
  assert.equal(update.ageRange, undefined, "11 pm is a bedtime, not an age");
});

test("already-known fields are not overwritten", () => {
  const update = extractStateFromMessages("im 40 now", "", {
    ...EMPTY,
    ageRange: "18-24",
  });
  assert.equal(update?.ageRange, undefined);
});
