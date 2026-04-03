/**
 * Conversation storage for Luna chatbot.
 * Uses Upstash Redis when configured; falls back to in-memory store for local dev.
 *
 * Setup (production):
 * 1. Create Redis database at https://console.upstash.com (free tier available)
 * 2. Add to Vercel: Project → Storage → Create Database → Redis (Upstash)
 * 3. Or set env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *
 * Session expiry: 30 days of inactivity (configurable via SESSION_TTL_SECONDS)
 */

const SESSION_TTL = parseInt(process.env.SESSION_TTL_SECONDS || "2592000", 10); // 30 days
const MAX_MESSAGES = 20; // Keep last 20 messages to stay within token limits

// In-memory fallback for local dev when Redis isn't configured
const memoryStore = new Map();
let hasWarnedNoRedis = false;

function getRedisClient() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL ||
    process.env.REDIS_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    process.env.REDIS_REST_API_TOKEN;

  if (!url || !token) return null;

  try {
    // Dynamic import to avoid errors when @upstash/redis isn't installed
    const { Redis } = require("@upstash/redis");
    return new Redis({ url, token });
  } catch {
    return null;
  }
}

const redis = getRedisClient();

function sessionKey(phoneNumber) {
  return `luna:${phoneNumber.replace(/\D/g, "")}`;
}

function createEmptySession() {
  return {
    messages: [],
    state: {
      ageRange: null,
      mainReason: null,
      severity: null,
      branchesVisited: [],
      escalationIssued: false,
      stage: "entry",
    },
    lastActivity: Date.now(),
  };
}

/**
 * Load conversation for a user. Returns session object or null.
 */
async function getSession(phoneNumber) {
  const key = sessionKey(phoneNumber);

  if (redis) {
    try {
      const raw = await redis.get(key);
      if (!raw) return null;
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      return { ...createEmptySession(), ...data };
    } catch (err) {
      console.error("Redis get error:", err);
      return memoryStore.get(key) || null;
    }
  }

  return memoryStore.get(key) || null;
}

/**
 * Save conversation for a user. Truncates message history to stay within limits.
 */
async function saveSession(phoneNumber, session) {
  const key = sessionKey(phoneNumber);

  // Truncate messages to avoid token overflow
  const messages = session.messages.slice(-MAX_MESSAGES);
  const toSave = {
    ...session,
    messages,
    lastActivity: Date.now(),
  };

  if (redis) {
    try {
      await redis.set(key, JSON.stringify(toSave), { ex: SESSION_TTL });
    } catch (err) {
      console.error("Redis set error:", err);
      memoryStore.set(key, toSave);
    }
  } else {
    memoryStore.set(key, toSave);
    if (!hasWarnedNoRedis && process.env.NODE_ENV !== "test") {
      hasWarnedNoRedis = true;
      console.warn(
        "[Luna] Redis not configured. Using in-memory store (data lost on restart). Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for persistence."
      );
    }
  }
}

/**
 * Append a message and optionally update state. Returns updated session.
 */
async function appendMessage(phoneNumber, role, content, stateUpdate = null) {
  let session = await getSession(phoneNumber);

  if (!session) {
    session = createEmptySession();
  }

  session.messages.push({ role, content });
  if (stateUpdate && typeof stateUpdate === "object") {
    session.state = { ...session.state, ...stateUpdate };
  }
  session.lastActivity = Date.now();

  await saveSession(phoneNumber, session);
  return session;
}

/**
 * Delete a user's session from Redis (honors "forget me" privacy promise).
 */
async function deleteSession(phoneNumber) {
  const key = sessionKey(phoneNumber);

  if (redis) {
    try {
      await redis.del(key);
    } catch (err) {
      console.error("Redis del error:", err);
      memoryStore.delete(key);
    }
  } else {
    memoryStore.delete(key);
  }
}

/**
 * Extract state updates from user message and assistant reply using keyword matching.
 * No extra AI calls — just pattern matching on the conversation text.
 */
function extractStateFromMessages(userMessage, assistantMessage, currentState) {
  const update = {};
  const userLower = userMessage.toLowerCase();
  const assistantLower = assistantMessage.toLowerCase();

  // Age range detection
  if (!currentState.ageRange) {
    if (/\bunder\s*13\b/.test(userLower)) update.ageRange = "under 13";
    else if (/\b13[\s–-]*17\b/.test(userLower)) update.ageRange = "13-17";
    else if (/\b18[\s–-]*24\b/.test(userLower)) update.ageRange = "18-24";
    else if (/\b25[\s–-]*35\b/.test(userLower)) update.ageRange = "25-35";
    else if (/\b36\s*\+/.test(userLower) || /\bover\s*36\b/.test(userLower) || /\b36\s*and\s*(older|above|up)\b/.test(userLower)) update.ageRange = "36+";
  }

  // Main reason detection
  if (!currentState.mainReason) {
    if (/trouble\s+falling\s+asleep/i.test(userLower) || /can'?t\s+fall\s+asleep/i.test(userLower)) {
      update.mainReason = "trouble falling asleep";
    } else if (/waking\s+up\s+(during|at\s+night|in\s+the)/i.test(userLower) || /wake\s+up\s+(during|at\s+night|in\s+the|multiple)/i.test(userLower)) {
      update.mainReason = "waking up during the night";
    } else if (/anxiety|racing\s+thoughts/i.test(userLower)) {
      update.mainReason = "anxiety or racing thoughts";
    } else if (/just\s+curious|want\s+tips/i.test(userLower) || /curious/i.test(userLower) && /tips/i.test(userLower)) {
      update.mainReason = "just curious / want tips";
    }
  }

  // Severity detection
  if (!currentState.severity) {
    if (/pretty\s+chill/i.test(userLower) || /not\s+(that|very)\s+(bad|serious)/i.test(userLower)) {
      update.severity = "pretty chill";
    } else if (/bothering\s+me/i.test(userLower) || /been\s+bothering/i.test(userLower)) {
      update.severity = "bothering me a while";
    } else if (/making\s+life\s+(really\s+)?hard/i.test(userLower) || /really\s+hard/i.test(userLower) || /severely/i.test(userLower)) {
      update.severity = "making life hard";
    }
  }

  // Stage progression
  const mergedState = { ...currentState, ...update };
  if (mergedState.ageRange && mergedState.stage === "entry") {
    update.stage = "intake";
  }
  if (mergedState.ageRange && mergedState.mainReason && mergedState.severity && mergedState.stage !== "tailored") {
    update.stage = "tailored";
  }

  // Branches visited — detect branch keywords in Luna's response
  const branchKeywords = {
    "Bedtime Routine": /bedtime\s+routine|wind[\s-]*down|screen\s+time\s+before\s+bed/i,
    "Racing Mind": /racing\s+mind|mind\s+races|racing\s+thoughts/i,
    "Morning Alertness": /morning\s+alertness|wake\s+up.*groggy|how\s+do\s+you.*feel\s+when\s+you\s+wake/i,
    "Wake-Up Triggers": /wake[\s-]*up\s+trigger|trigger.*wake/i,
    "Sleep Schedule": /sleep\s+schedule|what\s+time\s+do\s+you.*go\s+to\s+bed/i,
    "Pre-Bed Thoughts": /pre[\s-]*bed\s+thoughts|on\s+your\s+mind\s+before\s+bed/i,
    "Always Tired": /always.*tired|tired\s+no\s+matter/i,
    "Stress Changes": /recent\s+changes?\s+in\s+stress|stress\s+levels?\s+or\s+daily/i,
    "Specific Racing Thoughts": /specific\s+type\s+of\s+thought/i,
    "Afternoon Drowsiness": /afternoon\s+drowsiness|afternoon\s+energy/i,
  };

  const visited = new Set(currentState.branchesVisited || []);
  for (const [branch, pattern] of Object.entries(branchKeywords)) {
    if (pattern.test(assistantLower) && !visited.has(branch)) {
      visited.add(branch);
    }
  }
  if (visited.size > (currentState.branchesVisited || []).length) {
    update.branchesVisited = Array.from(visited);
  }

  return Object.keys(update).length > 0 ? update : null;
}

/**
 * Build a user profile block from session state for injection into the system prompt.
 */
function buildUserProfile(state) {
  if (!state || !state.ageRange) return "";

  const lines = ["[USER PROFILE]"];
  if (state.ageRange) lines.push(`Age range: ${state.ageRange}`);
  if (state.mainReason) lines.push(`Main concern: ${state.mainReason}`);
  if (state.severity) lines.push(`Severity: ${state.severity}`);
  if (state.stage) lines.push(`Stage: ${state.stage}${state.stage === "tailored" ? " (onboarding complete)" : ""}`);
  if (state.branchesVisited?.length) lines.push(`Branches explored: ${state.branchesVisited.join(", ")}`);
  lines.push("Sessions: returning user");

  return lines.join("\n");
}

/**
 * Build messages array for OpenAI: system + user profile + conversation history + new user message.
 */
function buildMessages(systemPrompt, session, newUserMessage) {
  let fullSystemPrompt = systemPrompt;

  // Inject user profile if state has meaningful data
  if (session?.state) {
    const profile = buildUserProfile(session.state);
    if (profile) {
      fullSystemPrompt = systemPrompt + "\n\n" + profile;
    }
  }

  const messages = [{ role: "system", content: fullSystemPrompt }];

  if (session?.messages?.length) {
    for (const msg of session.messages) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  messages.push({ role: "user", content: newUserMessage });
  return messages;
}

module.exports = {
  getSession,
  saveSession,
  appendMessage,
  buildMessages,
  createEmptySession,
  deleteSession,
  extractStateFromMessages,
  buildUserProfile,
  SESSION_TTL,
  MAX_MESSAGES,
};
