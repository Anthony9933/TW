const twilio = require("twilio");
const OpenAI = require("openai");
const querystring = require("querystring");
const {
  getSession,
  appendMessage,
  buildMessages,
  deleteSession,
  extractStateFromMessages,
} = require("../lib/conversation");
const LUNA_SYSTEM_PROMPT = require("../lib/luna-prompt");
const {
  recordInbound,
  recordOutbound,
  recordError,
  recordForgetMe,
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
    const messages = buildMessages(LUNA_SYSTEM_PROMPT, session, incomingMessage);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 1500,
    });

    const reply = completion.choices[0].message.content;
    await recordOutbound(from, completion.usage);

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
