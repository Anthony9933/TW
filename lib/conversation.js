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
const MAX_MESSAGES = 50; // Keep last 50 messages to stay within token limits

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

// Marker that wraps the hidden state metadata the model appends to each reply.
const STATE_BLOCK_REGEX = /<<<STATE>>>\s*(\{[\s\S]*?\})\s*<<<END>>>/;

const VALID_AGE_RANGES = new Set(["under 13", "13-17", "18-24", "25-35", "36+"]);
const VALID_REASONS = new Set([
  "trouble falling asleep",
  "waking up during the night",
  "anxiety or racing thoughts",
  "just curious / want tips",
]);
const VALID_SEVERITIES = new Set([
  "pretty chill",
  "bothering me a while",
  "making life hard",
]);
const VALID_BRANCHES = new Set([
  "Bedtime Routine",
  "Racing Mind",
  "Morning Alertness",
  "Wake-Up Triggers",
  "Sleep Schedule",
  "Pre-Bed Thoughts",
  "Always Tired",
  "Stress Changes",
  "Specific Racing Thoughts",
  "Afternoon Drowsiness",
]);

/**
 * Split the model's raw reply into the user-facing text and the hidden state
 * metadata block it appends. The metadata is classified in canonical English by
 * the model regardless of the conversation language, which is what makes
 * analytics work for Arabic (and any other language) conversations.
 *
 * @returns {{ visibleReply: string, meta: Object|null }}
 */
function parseReplyAndState(rawReply) {
  if (typeof rawReply !== "string") {
    return { visibleReply: "", meta: null };
  }

  const match = rawReply.match(STATE_BLOCK_REGEX);
  if (!match) {
    return { visibleReply: rawReply.trim(), meta: null };
  }

  const visibleReply = rawReply.replace(STATE_BLOCK_REGEX, "").trim();

  let meta = null;
  try {
    meta = JSON.parse(match[1]);
  } catch (err) {
    console.error("[conversation] failed to parse state metadata:", err);
    meta = null;
  }

  return { visibleReply, meta };
}

/**
 * Turn the model's hidden metadata into a validated state delta, applying the
 * same stage-progression and branch-accumulation logic as the keyword path.
 * Only whitelisted values are accepted so a malformed block can't corrupt state
 * or pollute analytics.
 */
function stateUpdateFromMeta(meta, currentState) {
  if (!meta || typeof meta !== "object") return null;

  const update = {};

  if (!currentState.ageRange && VALID_AGE_RANGES.has(meta.ageRange)) {
    update.ageRange = meta.ageRange;
  }
  if (!currentState.mainReason && VALID_REASONS.has(meta.mainReason)) {
    update.mainReason = meta.mainReason;
  }
  if (!currentState.severity && VALID_SEVERITIES.has(meta.severity)) {
    update.severity = meta.severity;
  }

  // Track the conversation language so we can surface it on the dashboard.
  if (meta.language === "ar" || meta.language === "en") {
    if (currentState.language !== meta.language) {
      update.language = meta.language;
    }
  }

  // Stage progression mirrors extractStateFromMessages.
  const mergedState = { ...currentState, ...update };
  if (mergedState.ageRange && mergedState.stage === "entry") {
    update.stage = "intake";
  }
  if (
    mergedState.ageRange &&
    mergedState.mainReason &&
    mergedState.severity &&
    mergedState.stage !== "tailored"
  ) {
    update.stage = "tailored";
  }

  // Branch accumulation.
  if (VALID_BRANCHES.has(meta.branch)) {
    const visited = new Set(currentState.branchesVisited || []);
    if (!visited.has(meta.branch)) {
      visited.add(meta.branch);
      update.branchesVisited = Array.from(visited);
    }
  }

  return Object.keys(update).length > 0 ? update : null;
}

/**
 * Extract state updates from user message and assistant reply using keyword matching.
 * No extra AI calls — just pattern matching on the conversation text.
 *
 * Note: this English-only keyword matcher is now a FALLBACK. The primary path is
 * parseReplyAndState + stateUpdateFromMeta, which works in any language. This is
 * still used to catch sleep-pattern details (bedtimes, durations, etc.) and as a
 * backstop when the model omits its metadata block.
 */
function extractStateFromMessages(userMessage, assistantMessage, currentState) {
  const update = {};
  const userLower = userMessage.toLowerCase();
  const assistantLower = assistantMessage.toLowerCase();

  // Age range detection — handles explicit ranges, decade phrasing ("mid 20s",
  // "in my 40s", "thirties"), "teen", "X years old", and bare numbers ("16").
  if (!currentState.ageRange) {
    const u = userLower;
    const bucketForAge = (n) =>
      n < 13 ? "under 13" : n <= 17 ? "13-17" : n <= 24 ? "18-24" : n <= 35 ? "25-35" : "36+";
    let age = null;

    if (/\bunder\s*13\b/.test(u)) update.ageRange = "under 13";
    else if (/\b13\s*[-–to]+\s*17\b/.test(u) || /\bteen(ager)?s?\b/.test(u)) update.ageRange = "13-17";
    else if (/\b18\s*[-–to]+\s*24\b/.test(u)) update.ageRange = "18-24";
    else if (/\b25\s*[-–to]+\s*35\b/.test(u)) update.ageRange = "25-35";
    else if (/\b36\s*\+/.test(u) || /\bover\s*3[0-9]\b/.test(u) || /\b3[6-9]\s*(?:and|or)?\s*(?:older|above|up)\b/.test(u)) update.ageRange = "36+";
    else {
      const decadeWord = u.match(/\b(twen|thir|for|fif|six)t(?:y|ies)\b/);
      const decadeNum = u.match(/\b(20|30|40|50|60)\s*'?s\b/);
      if (decadeWord || decadeNum) {
        const baseAge = decadeNum
          ? parseInt(decadeNum[1], 10)
          : { twen: 20, thir: 30, for: 40, fif: 50, six: 60 }[decadeWord[1]];
        const nudge = /\bmid\b/.test(u) ? 5 : /\blate\b/.test(u) ? 8 : 2;
        age = baseAge + nudge;
      } else {
        // Bare number, only when clearly an age (cue word, "yo"/"years old", or the whole message)
        const cue = u.match(/\b(?:i\s*am|i'?m|im|age|aged|turning|turned)\s*(\d{1,2})\b/);
        const yo = u.match(/\b(\d{1,2})\s*(?:yo|y\/o|years?\s*old)\b/);
        const bare = u.trim().match(/^(\d{1,2})$/);
        const looksLikeTime = /\b\d{1,2}\s*(?::\d|am|pm|hrs?|hours?|mins?|minutes?)\b/.test(u);
        if (!looksLikeTime) age = cue ? +cue[1] : yo ? +yo[1] : bare ? +bare[1] : null;
      }
      if (age != null && age >= 5 && age <= 99) update.ageRange = bucketForAge(age);
    }
  }

  // Main reason detection — broadened to match natural phrasing.
  if (!currentState.mainReason) {
    const u = userLower;
    if (/can'?t\s+(?:fall|get\s+to)\s+sleep|cant\s+(?:fall|get\s+to)\s+sleep|trouble\s+(?:falling|getting\s+to)\s+sleep|hard\s+(?:time\s+)?(?:to\s+)?fall(?:ing)?\s+asleep|takes?\s+(?:me\s+)?(?:forever|ages|hours|so\s+long)\s+to\s+(?:fall\s+)?(?:a)?sleep|lie\s+awake|can'?t\s+sleep\b|cant\s+sleep\b/.test(u)) {
      update.mainReason = "trouble falling asleep";
    } else if (/wak(?:e|ing)\s+up|keep\s+waking|woke\s+up|up\s+(?:at|around)\s+\d|\b[1-4]\s*am\b|middle\s+of\s+the\s+night|multiple\s+times|several\s+times|few\s+times\s+a\s+night/.test(u)) {
      update.mainReason = "waking up during the night";
    } else if (/anxi|rac(?:e|es|ing)|mind\s+(?:won'?t|wont|doesn'?t|does\s*not)\s+(?:stop|quiet|shut)|overthink|can'?t\s+(?:switch|turn)\s+off|cant\s+(?:switch|turn)\s+off|worry|worrying|stress/.test(u)) {
      update.mainReason = "anxiety or racing thoughts";
    } else if (/just\s+curious|curious|want\s+(?:some\s+)?tips|some\s+tips|general\s+(?:advice|tips)|looking\s+for\s+tips/.test(u)) {
      update.mainReason = "just curious / want tips";
    }
  }

  // Severity detection — severe first, then moderate, then mild.
  if (!currentState.severity) {
    const u = userLower;
    if (/making\s+(?:my\s+)?life\s+(?:really\s+)?hard|ruin|severe|terrible|awful|horrible|really\s+bad|very\s+bad|so\s+bad|can'?t\s+function|cant\s+function|exhaust|barely\s+(?:sleep|function)|affect(?:ing|s)?\s+(?:my\s+)?(?:work|school|job|life|relationship)/.test(u)) {
      update.severity = "making life hard";
    } else if (/bothering|pretty\s+bad|kinda\s+bad|fairly\s+bad|been\s+(?:a\s+while|weeks|months|going\s+on)|for\s+(?:weeks|months|a\s+while|ages)|every\s+night|most\s+nights|on\s+and\s+off|keeps?\s+happening/.test(u)) {
      update.severity = "bothering me a while";
    } else if (/pretty\s+chill|not\s+(?:that|too|very|really)\s+(?:bad|serious)|a\s+little|not\s+a\s+big\s+deal|\bmild\b|manageable|here\s+and\s+there|occasional|once\s+in\s+a\s+while|sometimes/.test(u)) {
      update.severity = "pretty chill";
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

  // Branches visited — detect branch keywords in user message OR Luna's response
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
    if ((pattern.test(userLower) || pattern.test(assistantLower)) && !visited.has(branch)) {
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
  parseReplyAndState,
  stateUpdateFromMeta,
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
