const twilio = require("twilio");
const OpenAI = require("openai");
const querystring = require("querystring");
const {
  getSession,
  appendMessage,
  buildMessages,
  deleteSession,
  extractStateFromMessages,
  addGoal,
  getGoalsNeedingFollowUp,
  recordTipGiven,
  wasTipRecentlyGiven,
  updateSleepPattern,
} = require("../lib/conversation");
const LUNA_SYSTEM_PROMPT = require("../lib/luna-prompt");
const {
  recordInbound,
  recordOutbound,
  recordError,
  recordForgetMe,
  recordStateUpdate,
  recordSessionEngagement,
  recordGoalCreated,
  recordGoalCompleted,
} = require("../lib/analytics");

// Vercel doesn't auto-parse urlencoded bodies, so we need to do it manually
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(querystring.parse(data)));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  let senderForError = null;
  try {
    // Parse the body if not already parsed
    const body = req.body || (await parseBody(req));

    const incomingMessage = body.Body;
    const from = body.From;
    senderForError = from;

    console.log(`Message from ${from}: ${incomingMessage}`);
    console.log(`OPENAI_API_KEY set: ${!!process.env.OPENAI_API_KEY}`);

    // Handle "forget me" requests — wipe session and respond immediately
    const forgetPattern =
      /\b(forget\s+me|delete\s+my\s+data|erase\s+(my\s+)?data|wipe\s+(my\s+)?(data|everything))\b/i;
    if (forgetPattern.test(incomingMessage)) {
      await deleteSession(from);
      await recordForgetMe(from);
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(
        "Done \u2014 all your data has been wiped. If you ever want to chat again, just send me a message and we\u2019ll start fresh. Take care! \ud83d\udc99"
      );
      res.setHeader("Content-Type", "text/xml");
      return res.status(200).send(twiml.toString());
    }

    await recordInbound(from);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Load conversation history for this user (keyed by phone number)
    const session = await getSession(from);
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

    const messages = buildMessages(LUNA_SYSTEM_PROMPT + goalsContext, session, incomingMessage);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 1500,
    });

    const reply = completion.choices[0].message.content;
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

    // Extract state updates from the conversation (keyword matching, no extra AI calls)
    const currentState = session?.state || {
      ageRange: null,
      mainReason: null,
      severity: null,
      branchesVisited: [],
      escalationIssued: false,
      stage: "entry",
    };
    const stateUpdate = extractStateFromMessages(
      incomingMessage,
      reply,
      currentState
    );

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
    await appendMessage(from, "user", incomingMessage);
    await appendMessage(from, "assistant", reply, stateUpdate);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send(twiml.toString());
  } catch (error) {
    console.error("Webhook error:", error);

    try {
      if (senderForError) await recordError(senderForError);
    } catch (_) {
      /* ignore analytics errors */
    }

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Sorry, something went wrong. Please try again.");

    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send(twiml.toString());
  }
};
