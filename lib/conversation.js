/**
 * Conversation storage for Luna chatbot.
 * Uses Redis when configured; falls back to in-memory store for local dev.
 *
 * Supported Redis types:
 * - Upstash REST API: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 * - Vercel KV: KV_REST_API_URL + KV_REST_API_TOKEN
 * - Traditional Redis: REDIS_URL (redis://...)
 *
 * Session expiry: 30 days of inactivity (configurable via SESSION_TTL_SECONDS)
 */

const { createRedisClient } = require("./redis-client");

const SESSION_TTL = parseInt(process.env.SESSION_TTL_SECONDS || "2592000", 10); // 30 days
const MAX_MESSAGES = 20; // Keep last 20 messages to stay within token limits

// In-memory fallback for local dev when Redis isn't configured
const memoryStore = new Map();
let hasWarnedNoRedis = false;

const redis = createRedisClient();

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
      // Onboarding tracking
      hasSeenWelcome: false,
      conversationCount: 0,
      lastConversationDate: null,
      // Goal tracking
      goals: [],
      // Sleep pattern tracking
      sleepPatterns: {
        bedtimeRange: null,
        wakeTimeRange: null,
        sleepDuration: null,
        sleepQuality: [],
        environmentFactors: {
          roomTemperature: null,
          screenTime: null,
          caffeine: null,
          exercise: null,
        },
        triggers: [],
        improvements: [],
      },
      // Tips tracking (prevent repetition)
      tipsGiven: [],
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

  // Sleep pattern extraction from user message
  if (!update.sleepPatterns) update.sleepPatterns = {};

  // Bedtime detection
  const bedtimeMatch = userLower.match(/(?:go to bed|sleep|bedtime).*?(?:around|at|about)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (bedtimeMatch && !currentState.sleepPatterns?.bedtimeRange) {
    let hour = parseInt(bedtimeMatch[1], 10);
    const minutes = bedtimeMatch[2] || "00";
    const meridiem = bedtimeMatch[3]?.toLowerCase();

    // Convert to 24-hour format
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    // Assume PM for hours 7-11 without meridiem (likely evening)
    if (!meridiem && hour >= 7 && hour <= 11) hour += 12;

    update.sleepPatterns.bedtimeRange = `${hour}:${minutes}`;
  }

  // Wake time detection
  const wakeMatch = userLower.match(/(?:wake up|get up|alarm).*?(?:around|at|about)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (wakeMatch && !currentState.sleepPatterns?.wakeTimeRange) {
    let hour = parseInt(wakeMatch[1], 10);
    const minutes = wakeMatch[2] || "00";
    const meridiem = wakeMatch[3]?.toLowerCase();

    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    // Assume AM for hours 4-11 without meridiem (likely morning)
    if (!meridiem && hour >= 4 && hour <= 11) {
      // Already in AM format
    }

    update.sleepPatterns.wakeTimeRange = `${hour}:${minutes}`;
  }

  // Sleep duration detection
  const durationMatch = userLower.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:of\s+)?(?:sleep)?/i);
  if (durationMatch && !currentState.sleepPatterns?.sleepDuration) {
    update.sleepPatterns.sleepDuration = `${durationMatch[1]}h`;
  }

  // Sleep quality detection
  if (/slept\s+(well|great|good|fine)/i.test(userLower)) {
    update.sleepPatterns.sleepQuality = "good";
  } else if (/(?:terrible|awful|horrible|bad)\s+(?:night|sleep)/i.test(userLower) || /didn'?t\s+sleep\s+well/i.test(userLower)) {
    update.sleepPatterns.sleepQuality = "poor";
  }

  // Environment factors
  if (!update.sleepPatterns.environmentFactors) update.sleepPatterns.environmentFactors = {};

  if (/phone\s+in\s+bed|screen.*bed|scrolling.*bed|using.*phone.*bed/i.test(userLower)) {
    update.sleepPatterns.environmentFactors.screenTime = "high";
  }

  if (/coffee|caffeine|energy\s+drink/i.test(userLower)) {
    if (/afternoon|evening|late|after\s+\d+\s*pm/i.test(userLower)) {
      update.sleepPatterns.environmentFactors.caffeine = "afternoon/evening";
    } else {
      update.sleepPatterns.environmentFactors.caffeine = "morning";
    }
  }

  if (/room\s+(?:is\s+)?(?:too\s+)?(?:hot|warm)/i.test(userLower)) {
    update.sleepPatterns.environmentFactors.roomTemperature = "too warm";
  } else if (/room\s+(?:is\s+)?(?:too\s+)?cold/i.test(userLower)) {
    update.sleepPatterns.environmentFactors.roomTemperature = "too cold";
  }

  if (/exercise|workout|gym|run|jog/i.test(userLower)) {
    if (/evening|night|before\s+bed/i.test(userLower)) {
      update.sleepPatterns.environmentFactors.exercise = "evening";
    } else {
      update.sleepPatterns.environmentFactors.exercise = "regular";
    }
  }

  // Clean up empty sleepPatterns object
  if (Object.keys(update.sleepPatterns).length === 0 ||
      (Object.keys(update.sleepPatterns).length === 1 &&
       update.sleepPatterns.environmentFactors &&
       Object.keys(update.sleepPatterns.environmentFactors).length === 0)) {
    delete update.sleepPatterns;
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

  // Conversation history
  if (state.conversationCount) {
    lines.push(`Conversations: ${state.conversationCount}`);
  }
  if (state.lastConversationDate) {
    const daysSince = Math.floor((Date.now() - state.lastConversationDate) / (24 * 60 * 60 * 1000));
    if (daysSince > 0) {
      lines.push(`Last conversation: ${daysSince} day${daysSince === 1 ? '' : 's'} ago`);
    }
  }

  // Active goals
  const activeGoals = state.goals?.filter(g => g.status === "active") || [];
  if (activeGoals.length > 0) {
    lines.push("");
    lines.push(`Active goals (${activeGoals.length}):`);
    for (const goal of activeGoals) {
      const daysAgo = Math.floor((Date.now() - goal.suggestedAt) / (24 * 60 * 60 * 1000));
      lines.push(`  - "${goal.description}" (${daysAgo} day${daysAgo === 1 ? '' : 's'} ago)`);
    }
  }

  // Sleep patterns
  const patterns = state.sleepPatterns;
  if (patterns && (patterns.bedtimeRange || patterns.wakeTimeRange || patterns.sleepDuration)) {
    lines.push("");
    lines.push("Sleep patterns:");
    if (patterns.bedtimeRange) lines.push(`  Bedtime: ${patterns.bedtimeRange}`);
    if (patterns.wakeTimeRange) lines.push(`  Wake time: ${patterns.wakeTimeRange}`);
    if (patterns.sleepDuration) lines.push(`  Duration: ${patterns.sleepDuration}`);

    // Recent sleep quality
    if (patterns.sleepQuality?.length > 0) {
      const recent = patterns.sleepQuality.slice(-7); // Last 7 entries
      const goodNights = recent.filter(q => q.quality === "good").length;
      lines.push(`  Recent quality: ${goodNights}/${recent.length} good nights`);
    }

    // Environment factors
    const env = patterns.environmentFactors;
    if (env && Object.keys(env).some(k => env[k])) {
      lines.push("  Environment factors:");
      if (env.screenTime) lines.push(`    - Screen time: ${env.screenTime}`);
      if (env.caffeine) lines.push(`    - Caffeine: ${env.caffeine}`);
      if (env.roomTemperature) lines.push(`    - Room temperature: ${env.roomTemperature}`);
      if (env.exercise) lines.push(`    - Exercise: ${env.exercise}`);
    }
  }

  // Tips already given (prevent repetition)
  const recentTips = state.tipsGiven?.filter(tip =>
    tip.givenAt > Date.now() - (30 * 24 * 60 * 60 * 1000)
  ) || [];

  if (recentTips.length > 0) {
    const categories = [...new Set(recentTips.map(t => t.category))];
    lines.push("");
    lines.push(`Tips already given: ${categories.join(", ")}`);
    lines.push("(DO NOT repeat these tip categories)");
  }

  // Branches explored
  if (state.branchesVisited?.length) {
    lines.push("");
    lines.push(`Branches explored: ${state.branchesVisited.join(", ")}`);
  }

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

/**
 * Add a new goal to the user's session.
 * @param {Object} session - User session object
 * @param {Object} goalData - { description, category }
 */
function addGoal(session, goalData) {
  if (!session?.state) return;

  const goal = {
    id: `goal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    description: goalData.description,
    category: goalData.category || "general",
    suggestedAt: Date.now(),
    status: "active",
    lastFollowUpAt: null,
    completionDate: null,
    userNotes: [],
  };

  if (!session.state.goals) session.state.goals = [];
  session.state.goals.push(goal);

  return goal.id;
}

/**
 * Update a goal's status and add an optional note.
 * @param {Object} session - User session object
 * @param {string} goalId - Goal ID to update
 * @param {string} status - "active", "completed", "abandoned"
 * @param {string} note - Optional user note
 */
function updateGoalStatus(session, goalId, status, note = null) {
  if (!session?.state?.goals) return false;

  const goal = session.state.goals.find(g => g.id === goalId);
  if (!goal) return false;

  goal.status = status;
  goal.lastFollowUpAt = Date.now();

  if (status === "completed") {
    goal.completionDate = Date.now();
  }

  if (note) {
    goal.userNotes.push({
      note,
      timestamp: Date.now(),
    });
  }

  return true;
}

/**
 * Get goals that need follow-up (active, not followed up in 3+ days).
 * @param {Object} session - User session object
 * @returns {Array} Goals needing follow-up
 */
function getGoalsNeedingFollowUp(session) {
  if (!session?.state?.goals) return [];

  const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);

  return session.state.goals.filter(goal => {
    if (goal.status !== "active") return false;

    const lastCheck = goal.lastFollowUpAt || goal.suggestedAt;
    return lastCheck < threeDaysAgo;
  });
}

/**
 * Record a tip given to the user.
 * @param {Object} session - User session object
 * @param {Object} tipData - { category, tip, branch }
 */
function recordTipGiven(session, tipData) {
  if (!session?.state) return;

  const tipRecord = {
    id: `tip_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    category: tipData.category,
    tip: tipData.tip,
    givenAt: Date.now(),
    branch: tipData.branch || "unknown",
    wasEffective: null,
  };

  if (!session.state.tipsGiven) session.state.tipsGiven = [];
  session.state.tipsGiven.push(tipRecord);
}

/**
 * Check if a tip category was recently given (within 30 days).
 * @param {Object} session - User session object
 * @param {string} tipCategory - Category to check
 * @returns {boolean}
 */
function wasTipRecentlyGiven(session, tipCategory) {
  if (!session?.state?.tipsGiven) return false;

  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

  return session.state.tipsGiven.some(tip =>
    tip.category === tipCategory && tip.givenAt > thirtyDaysAgo
  );
}

/**
 * Update sleep pattern data.
 * @param {Object} session - User session object
 * @param {Object} patternData - Sleep pattern updates
 */
function updateSleepPattern(session, patternData) {
  if (!session?.state?.sleepPatterns) {
    session.state.sleepPatterns = {
      bedtimeRange: null,
      wakeTimeRange: null,
      sleepDuration: null,
      sleepQuality: [],
      environmentFactors: {},
      triggers: [],
      improvements: [],
    };
  }

  const patterns = session.state.sleepPatterns;

  if (patternData.bedtimeRange) patterns.bedtimeRange = patternData.bedtimeRange;
  if (patternData.wakeTimeRange) patterns.wakeTimeRange = patternData.wakeTimeRange;
  if (patternData.sleepDuration) patterns.sleepDuration = patternData.sleepDuration;

  if (patternData.sleepQuality !== undefined) {
    patterns.sleepQuality.push({
      quality: patternData.sleepQuality,
      date: Date.now(),
    });
    // Keep only last 30 entries
    if (patterns.sleepQuality.length > 30) {
      patterns.sleepQuality = patterns.sleepQuality.slice(-30);
    }
  }

  if (patternData.environmentFactors) {
    patterns.environmentFactors = {
      ...patterns.environmentFactors,
      ...patternData.environmentFactors,
    };
  }

  if (patternData.trigger) {
    if (!patterns.triggers.includes(patternData.trigger)) {
      patterns.triggers.push(patternData.trigger);
    }
  }

  if (patternData.improvement) {
    if (!patterns.improvements.includes(patternData.improvement)) {
      patterns.improvements.push(patternData.improvement);
    }
  }
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
  addGoal,
  updateGoalStatus,
  getGoalsNeedingFollowUp,
  recordTipGiven,
  wasTipRecentlyGiven,
  updateSleepPattern,
  SESSION_TTL,
  MAX_MESSAGES,
};
