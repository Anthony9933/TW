const twilio = require("twilio");
const OpenAI = require("openai");
const querystring = require("querystring");
const {
  getSessionResult,
  saveSession,
  buildMessages,
  deleteSession,
  createEmptySession,
  parseReplyAndState,
  stateUpdateFromMeta,
  extractStateFromMessages,
  addGoal,
  getGoalsNeedingFollowUp,
  recordTipGiven,
  wasTipRecentlyGiven,
  updateSleepPattern,
} = require("../lib/conversation");
const LUNA_SYSTEM_PROMPT = require("../lib/luna-prompt");
const PRIVACY_NOTICE = require("../lib/privacy-notice");
const {
  recordInbound,
  recordOutbound,
  recordError,
  recordForgetMe,
  recordStateUpdate,
  recordSessionEngagement,
  recordGoalCreated,
} = require("../lib/analytics");

// Vercel doesn't always auto-parse urlencoded bodies, so read the raw stream
// ourselves. We keep the raw text because Twilio signature validation needs the
// exact parameters that were posted.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function parseRequest(req) {
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
    return { params: req.body, raw: null };
  }
  const raw = typeof req.body === "string" ? req.body : await readBody(req);
  return { params: querystring.parse(raw || ""), raw };
}

/**
 * Candidate public URLs this request could have been signed against. Twilio
 * signs the exact URL configured in its console; behind Vercel's proxy the
 * original host arrives in `x-forwarded-host`, so try both it and `host`.
 */
function candidateUrls(req) {
  if (process.env.TWILIO_WEBHOOK_URL) return [process.env.TWILIO_WEBHOOK_URL];
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const hosts = [req.headers["x-forwarded-host"], req.headers.host]
    .filter(Boolean)
    .map((h) => String(h).split(",")[0].trim());
  const path = req.url || "/api/webhook";
  return [...new Set(hosts)].map((h) => `${proto}://${h}${path}`);
}

/**
 * Verify the request really came from Twilio.
 *
 * Enabled whenever TWILIO_AUTH_TOKEN is set. Without this the webhook is an
 * open endpoint: anyone can post a `From` number and burn OpenAI credit or
 * poison another user's conversation history. Set
 * TWILIO_VALIDATE_SIGNATURE=false to opt out (useful for local testing).
 */
function isValidTwilioRequest(req, params) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return true; // nothing to validate against
  if (String(process.env.TWILIO_VALIDATE_SIGNATURE).toLowerCase() === "false") return true;

  const signature = req.headers["x-twilio-signature"];
  if (!signature) return false;

  return candidateUrls(req).some((url) => {
    try {
      return twilio.validateRequest(token, signature, url, params);
    } catch (_) {
      return false;
    }
  });
}

/** Send one or more TwiML messages (each becomes a separate WhatsApp message). */
function sendReply(res, ...messages) {
  const twiml = new twilio.twiml.MessagingResponse();
  for (const m of messages) {
    if (m) twiml.message(m);
  }
  res.setHeader("Content-Type", "text/xml");
  return res.status(200).send(twiml.toString());
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  let senderForError = null;
  try {
    const { params } = await parseRequest(req);

    if (!isValidTwilioRequest(req, params)) {
      console.warn("[luna] rejected request with missing/invalid Twilio signature");
      return res.status(403).send("Forbidden");
    }

    const from = params.From;
    senderForError = from;

    if (!from) {
      return res.status(400).send("Missing From");
    }

    const incomingMessage = typeof params.Body === "string" ? params.Body.trim() : "";
    const mediaCount = parseInt(params.NumMedia || "0", 10) || 0;

    console.log(`[luna] message from ${from} (${incomingMessage.length} chars, ${mediaCount} media)`);

    // Handle "forget me" requests — wipe session and respond immediately
    const forgetPattern =
      /\b(forget\s+me|delete\s+my\s+data|erase\s+(my\s+)?data|wipe\s+(my\s+)?(data|everything))\b/i;
    if (forgetPattern.test(incomingMessage)) {
      await deleteSession(from);
      await recordForgetMe(from);
      return sendReply(
        res,
        "Done \u2014 all your data has been wiped. If you ever want to chat again, just send me a message and we\u2019ll start fresh. Take care! \ud83d\udc99"
      );
    }

    // Load conversation history for this user (keyed by phone number).
    // `storeOk` tells us whether the read actually succeeded — see below.
    const { session, durable } = await getSessionResult(from);
    const needsPrivacyNotice = !session?.state?.privacyNoticeSent;

    if (!durable) {
      // Loud on purpose. Without storage that survives between invocations we
      // cannot tell a returning user from a new one, so every message looks
      // like first contact. Check /api/dashboard-data for storage health.
      console.error(
        "[luna] NO DURABLE SESSION STORE \u2014 conversations will not be remembered. " +
          "Configure Redis (see README \u203a Troubleshooting)."
      );
    }

    // First contact: send the privacy & compliance notice verbatim, before any
    // AI runs. Guarded on `storeOk`: if the session store is unreachable we
    // cannot tell a new user from a returning one, and replaying the notice on
    // every message would leave the bot stuck repeating its intro forever.
    // Standalone first-contact notice. Only when storage is durable — otherwise
    // every cold start would look like first contact and the bot would repeat
    // its intro forever instead of ever answering. The degraded path below
    // delivers the same notice alongside a real reply.
    if (durable && needsPrivacyNotice) {
      await recordInbound(from);
      await recordSessionEngagement(from, true);

      const sess = session || createEmptySession();
      sess.state.privacyNoticeSent = true;
      sess.state.hasSeenWelcome = true;
      // Preserve their first message so they don't have to repeat it next turn.
      if (incomingMessage) {
        sess.messages.push({ role: "user", content: incomingMessage });
      }
      sess.messages.push({ role: "assistant", content: PRIVACY_NOTICE });
      await saveSession(from, sess);
      await recordOutbound(from, null);

      return sendReply(res, PRIVACY_NOTICE);
    }

    // Voice notes, images and stickers arrive with an empty Body. Answer those
    // directly instead of forwarding an empty turn to the model. Placed after
    // the privacy gate so a new user still receives the notice first.
    if (!incomingMessage) {
      if (mediaCount > 0) {
        return sendReply(
          res,
          "I can only read text messages right now \u2014 could you type that out for me? \ud83d\udc99"
        );
      }
      return res
        .status(200)
        .send(new twilio.twiml.MessagingResponse().toString());
    }

    await recordInbound(from);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const isNewUser = !session || !session.messages || session.messages.length === 0;
    const isFirstMessage = isNewUser || !session?.state?.hasSeenWelcome;

    // Track session engagement only on first message of a session
    if (isNewUser || isFirstMessage) {
      await recordSessionEngagement(from, isNewUser);
    }

    // Track conversation count and date
    if (session?.state) {
      session.state.conversationCount = (session.state.conversationCount || 0) + 1;
      session.state.lastConversationDate = Date.now();
      if (isFirstMessage) {
        session.state.hasSeenWelcome = true;
      }
    }

    // Check for goals needing follow-up
    let goalsContext = "";
    if (session?.state?.goals) {
      const goalsNeedingFollowUp = getGoalsNeedingFollowUp(session);
      if (goalsNeedingFollowUp.length > 0) {
        goalsContext = "\n\n[PRIORITY: Follow up on these goals first]\n";
        goalsContext += goalsNeedingFollowUp.map(g => {
          const daysAgo = Math.floor((Date.now() - g.suggestedAt) / (24 * 60 * 60 * 1000));
          return `- "${g.description}" (suggested ${daysAgo} day${daysAgo === 1 ? '' : 's'} ago)`;
        }).join("\n");
      }
    }
    const messages = buildMessages(
      LUNA_SYSTEM_PROMPT + goalsContext,
      session,
      incomingMessage
    );

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 1500,
    });

    const rawReply = completion.choices[0].message.content;
    // Split the model's hidden state metadata off the user-facing text. `reply`
    // is what we show, store, and scan for goals/tips; `meta` drives analytics.
    const { visibleReply, meta } = parseReplyAndState(rawReply);
    const reply = visibleReply;
    await recordOutbound(from, completion.usage);

    // Auto-detect and track goals from Luna's response
    if (session?.state) {
      const goalPatterns = [
        /try\s+(?:the\s+)?([^.]+?)\s+(?:tonight|today|before bed|for the next)/i,
        /start\s+(?:a\s+)?([^.]+?)\s+(?:routine|habit|practice)/i,
        /set\s+(?:a\s+)?([^.]+?)\s+(?:time|goal|schedule)/i,
      ];

      for (const pattern of goalPatterns) {
        const match = reply.match(pattern);
        if (match) {
          const goalDesc = match[0].trim();
          let category = "general";

          // Categorize the goal
          if (/breath/i.test(goalDesc)) category = "breathing_exercise";
          else if (/screen/i.test(goalDesc)) category = "screen_management";
          else if (/routine/i.test(goalDesc)) category = "bedtime_routine";
          else if (/schedule|time/i.test(goalDesc)) category = "sleep_schedule";
          else if (/relax/i.test(goalDesc)) category = "relaxation";
          else if (/exercise|workout/i.test(goalDesc)) category = "exercise";
          else if (/caffeine|coffee/i.test(goalDesc)) category = "caffeine";
          else if (/environment|room|temperature/i.test(goalDesc)) category = "environment";

          // Only add if not already tracking this category as active
          if (!session.state.goals?.some(g => g.category === category && g.status === "active")) {
            addGoal(session, { description: goalDesc, category });
            await recordGoalCreated(from, category);
          }
          break; // Only track one goal per response
        }
      }

      // Track tips to prevent repetition
      const tipCategories = {
        'sleep_hygiene': /sleep hygiene|cool room|dark room|quiet/i,
        'screen_management': /screen|phone|blue light|tv/i,
        'caffeine': /caffeine|coffee|tea/i,
        'breathing': /breathing|4-7-8|box breath/i,
        'schedule': /consistent|same time|schedule/i,
        'relaxation': /progressive muscle relaxation|body scan|meditation/i,
        'exercise': /exercise|workout|physical activity/i,
        'environment': /temperature|noise|lighting|bedroom/i,
      };

      for (const [category, pattern] of Object.entries(tipCategories)) {
        if (pattern.test(reply) && !wasTipRecentlyGiven(session, category)) {
          const currentState = session.state;
          recordTipGiven(session, {
            category,
            tip: reply.substring(0, 100),
            branch: currentState.branchesVisited?.[currentState.branchesVisited.length - 1] || "unknown",
          });
        }
      }
    }

    // Derive state updates. Primary path: the model's hidden metadata block,
    // which is classified in canonical English regardless of conversation
    // language — this is what makes analytics work for Arabic conversations.
    // Fallback: English keyword matching, which still catches sleep-pattern
    // details (bedtimes, durations) and backstops a missing/invalid block.
    const currentState = session?.state || {
      ageRange: null,
      mainReason: null,
      severity: null,
      branchesVisited: [],
      escalationIssued: false,
      stage: "entry",
    };

    const metaUpdate = stateUpdateFromMeta(meta, currentState);
    const keywordUpdate = extractStateFromMessages(
      incomingMessage,
      reply,
      currentState
    );

    // Merge: keyword findings first, then let the model's metadata win on any
    // overlapping field (it understands intent across languages, regex doesn't).
    // branchesVisited is unioned so neither source drops a branch the other found.
    let stateUpdate = null;
    if (keywordUpdate || metaUpdate) {
      stateUpdate = { ...(keywordUpdate || {}), ...(metaUpdate || {}) };
      const mergedBranches = new Set([
        ...(keywordUpdate?.branchesVisited || []),
        ...(metaUpdate?.branchesVisited || []),
      ]);
      if (mergedBranches.size > 0) {
        stateUpdate.branchesVisited = Array.from(mergedBranches);
      }
    }

    // Handle sleep pattern updates specifically
    if (stateUpdate?.sleepPatterns && session?.state) {
      updateSleepPattern(session, stateUpdate.sleepPatterns);
      // Remove from stateUpdate as it's already merged
      delete stateUpdate.sleepPatterns;
    }

    // Track state updates for conversation analytics (only send the delta)
    if (stateUpdate) {
      // For branchesVisited, only send newly added branches (not the full array)
      const deltaForAnalytics = { ...stateUpdate };
      if (deltaForAnalytics.branchesVisited) {
        const oldBranches = new Set(currentState.branchesVisited || []);
        deltaForAnalytics.branchesVisited = deltaForAnalytics.branchesVisited.filter(
          (b) => !oldBranches.has(b)
        );
        if (deltaForAnalytics.branchesVisited.length === 0) {
          delete deltaForAnalytics.branchesVisited;
        }
      }
      await recordStateUpdate(from, deltaForAnalytics);
    }

    // Persist conversation + state updates for next turn
    // Persist in one write. Re-reading the session here (as two separate
    // appendMessage calls used to) would discard everything this turn mutated
    // in memory — goals, tips given, conversation count, sleep patterns.
    const toPersist = session || createEmptySession();
    toPersist.messages.push({ role: "user", content: incomingMessage });
    toPersist.messages.push({ role: "assistant", content: reply });
    if (stateUpdate && typeof stateUpdate === "object") {
      toPersist.state = { ...toPersist.state, ...stateUpdate };
    }
    toPersist.state.privacyNoticeSent = true;
    await saveSession(from, toPersist);

    // Degraded mode: storage is not durable, so the standalone notice branch
    // was skipped. Send the disclosure ahead of the answer as its own message
    // so the user still receives it and the conversation still moves forward.
    if (!durable && needsPrivacyNotice) {
      return sendReply(res, PRIVACY_NOTICE, reply);
    }

    return sendReply(res, reply);
  } catch (error) {
    console.error("Webhook error:", error);

    try {
      if (senderForError) await recordError(senderForError);
    } catch (_) {
      /* ignore analytics errors */
    }

    return sendReply(res, "Sorry, something went wrong. Please try again.");
  }
};
