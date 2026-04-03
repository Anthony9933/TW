# 📊 Conversation Analytics Guide

## What's Being Tracked

Your Luna bot now collects detailed conversation analytics to help you understand user behavior, sleep concerns, and engagement patterns.

---

## 📈 Analytics Categories

### 1. Demographics (Age Distribution)

**What it tracks:** User age ranges based on their responses

**Age brackets:**
- Under 13
- 13-17
- 18-24
- 25-35
- 36+

**How it works:** When Luna asks about age and users respond, the system extracts their age range using keyword matching and records it.

**Example dashboard view:**
```
Age Range       Count    % of Total
───────────────────────────────────
18-24            45        45%
25-35            32        32%
36+              15        15%
13-17             8         8%
```

**Use cases:**
- Understand your primary audience
- Tailor content to age demographics
- See which age groups struggle most with sleep

---

### 2. Sleep Concerns Breakdown

**What it tracks:** Primary sleep issues users report

**Categories:**
- Trouble falling asleep
- Waking up during the night
- Anxiety or racing thoughts
- Just curious / want tips

**How it works:** Keyword matching on user messages ("can't fall asleep", "wake up at night", "anxiety", "racing thoughts")

**Example dashboard view:**
```
Concern                       Count    % of Total
──────────────────────────────────────────────────
Trouble falling asleep          67        40%
Waking up during the night      50        30%
Anxiety or racing thoughts      33        20%
Just curious / want tips        17        10%
```

**Use cases:**
- Identify the most common sleep problems
- Prioritize content/features for top concerns
- See if certain concerns correlate with demographics

---

### 3. Severity Distribution

**What it tracks:** How serious users rate their sleep issues

**Levels:**
- Pretty chill (mild, not urgent)
- Bothering me a while (moderate, persistent)
- Making life hard (severe, significant impact)

**How it works:** Extracts severity from user descriptions ("it's pretty chill", "been bothering me", "making life really hard")

**Example dashboard view:**
```
Severity Level            Count    % of Total
─────────────────────────────────────────────
Bothering me a while        50        50%
Making life hard            35        35%
Pretty chill                15        15%
```

**Use cases:**
- Gauge urgency of user needs
- Identify users who might need professional help
- Track if your bot helps reduce severity over time

---

### 4. Conversation Funnel (Stages)

**What it tracks:** How far users progress through Luna's onboarding

**Stages:**
- **Entry:** Just started chatting (no profile data yet)
- **Intake:** Provided some info (age, concern, or severity)
- **Tailored:** Completed onboarding (age + concern + severity = personalized advice)

**How it works:** Automatically updated as users provide information during conversation

**Example dashboard view:**
```
Stage       Count    % of Total
──────────────────────────────────
Tailored      60        60%
Intake        25        25%
Entry         15        15%
```

**Use cases:**
- See drop-off rates (where users lose interest)
- Measure onboarding completion rate
- Identify if questions are too invasive (high entry/intake, low tailored)

---

### 5. Popular Conversation Branches

**What it tracks:** Topics Luna explores with users

**Topics tracked:**
- Bedtime Routine
- Racing Mind
- Morning Alertness
- Wake-Up Triggers
- Sleep Schedule
- Pre-Bed Thoughts
- Always Tired
- Stress Changes
- Specific Racing Thoughts
- Afternoon Drowsiness

**How it works:** Detects when Luna asks questions about specific topics (keyword matching on Luna's responses)

**Example dashboard view:**
```
Topic                      Count    % of Topics
───────────────────────────────────────────────
Bedtime Routine              45        25%
Racing Mind                  36        20%
Sleep Schedule               27        15%
Morning Alertness            23        13%
Wake-Up Triggers             18        10%
(Top 5 shown, up to 10 total)
```

**Use cases:**
- See which topics resonate most
- Identify under-explored areas
- Guide content development priorities

---

### 6. New vs Returning Users

**What it tracks:** First-time vs repeat conversations

**Metrics:**
- **New users:** No prior message history
- **Returning users:** Have chatted with Luna before

**How it works:** Checks if session exists before processing message

**Example dashboard view:**
```
User Type       Count
─────────────────────
Returning        87
New              34
```

**Use cases:**
- Measure retention (do people come back?)
- Calculate return rate
- See if Luna provides lasting value

---

### 7. Session Engagement

**What it tracks:** Message depth and conversation quality

**Metrics:**
- **Total sessions:** Unique conversation threads
- **Avg messages/session:** How many messages users send before stopping

**How it works:** Counts messages per user hash, calculates average

**Example dashboard view:**
```
Metric                    Value
────────────────────────────────
Total sessions              121
Avg messages/session        4.2
```

**Use cases:**
- Measure engagement depth
- Identify if conversations are too short (low engagement)
- See if users drop off quickly (avg < 2 = poor engagement)

---

## 🔄 How Data Flows

```
User sends message
    ↓
Webhook receives message
    ↓
Check if new or returning user
    ↓
Record: recordSessionEngagement(from, isNewUser)
    ↓
Get OpenAI response
    ↓
Extract state updates (age, concern, severity, stage, branches)
    ↓
If state changed:
    Record: recordStateUpdate(from, updatedState)
    ↓
Save conversation + state
    ↓
Send reply to user
```

**Redis Keys Created:**
```
sw:demographics:age:18-24 → 45
sw:concerns:trouble falling asleep → 67
sw:severity:bothering me a while → 50
sw:stage:tailored → 60
sw:branches:Bedtime Routine → 45
sw:sessions:new → 34
sw:sessions:returning → 87
sw:sessions:messages:{user_hash} → 4
```

---

## 📊 Dashboard Sections

### Conversation Analytics Section

The dashboard now includes a new "Conversation Analytics" section with:

1. **Demographics** - Age distribution cards
2. **Sleep Concerns** - Breakdown of primary issues
3. **Severity Levels** - How serious users' problems are
4. **Conversation Funnel** - Entry → Intake → Tailored progression
5. **Popular Topics** - Top 10 conversation branches
6. **User Behavior** - New vs returning + engagement metrics

Each metric shows:
- **Count:** Total occurrences
- **Percentage:** Proportion of total
- **Hints:** Contextual explanations

---

## 🎯 Key Insights You Can Get

### Audience Understanding
- "Most users are 18-24 with trouble falling asleep" → Target content for college students with bedtime routine advice
- "35% report severe issues" → Consider adding crisis resources or professional help recommendations

### Engagement Quality
- "Avg 4.2 messages/session" → Users are engaged, having real conversations (not one-off questions)
- "60% reach tailored stage" → Good onboarding completion rate
- "40% drop at entry/intake" → Might be too invasive too quickly

### Content Gaps
- "Bedtime Routine is #1 topic but Morning Alertness is low" → Add more morning alertness content
- "Few users explore Afternoon Drowsiness" → Either not relevant or not being surfaced

### Retention Health
- "87 returning vs 34 new" → 72% return rate = strong retention
- "34 new vs 87 returning" → Need more user acquisition

---

## 🚀 Using Analytics for Product Decisions

### Scenario 1: High Drop-Off at Entry
**Data:** 40% of users stay at "entry" stage (don't complete intake)

**Possible causes:**
- Questions feel too personal
- Takes too long to get value
- Unclear why info is needed

**Actions:**
- Make intake optional
- Provide value upfront (tips before asking questions)
- Explain why you're asking ("This helps me personalize advice for you!")

### Scenario 2: Low "Waking Up" Concern
**Data:** Only 10% report "waking up during the night"

**Possible causes:**
- People don't identify with the phrasing
- Most users have falling asleep issues instead
- Underdetected by keyword matching

**Actions:**
- Add more keywords ("wake up at 3am", "can't stay asleep")
- Ask explicitly in intake flow
- Adjust Luna's questions

### Scenario 3: Popular "Racing Mind" Topic
**Data:** 45% of conversations explore "Racing Mind"

**Insights:**
- High interest in anxiety/thought management
- Core pain point for users
- Opportunity area

**Actions:**
- Develop deeper "Racing Mind" content
- Create a dedicated flow for racing thoughts
- Add CBT-I techniques for intrusive thoughts

---

## 🔐 Privacy & Data Handling

### User Hashing
Phone numbers are hashed (SHA-256) before storage:
- `+15551234567` → `a3f2d8e1b4c5...` (16 chars)
- Analytics are anonymous
- No PII stored in analytics keys

### Data Retention
- **Analytics:** Stored indefinitely (counts, no personal data)
- **Conversations:** Expire after 30 days of inactivity
- **"Forget me":** Deletes conversation, keeps anonymous analytics

### What's Stored Where
```
Personal Data (deletable):
  luna:+15551234567 → {messages, state}

Anonymous Analytics (kept):
  sw:demographics:age:18-24 → 45
  sw:concerns:... → counts
  sw:sessions:messages:{hash} → message count
```

---

## 🧪 Testing Your Analytics

### Step 1: Have a Test Conversation
Send Luna a series of messages:
```
You: "Hi"
Luna: "Hey! ... How old are you?"
You: "I'm 22"
Luna: "What brings you here?"
You: "I can't fall asleep at night"
Luna: "How long has this been going on?"
You: "It's been bothering me for a while"
```

### Step 2: Check Dashboard
Refresh dashboard, you should see:
- Demographics: 18-24 = 1
- Concerns: trouble falling asleep = 1
- Severity: bothering me a while = 1
- Stages: tailored = 1 (if age+concern+severity captured)
- Session stats: new = 1

### Step 3: Return User Test
Send another message from same number:
```
You: "Hey Luna, I'm back"
```

Dashboard should show:
- Session stats: returning = 1
- Avg messages/session updated

---

## 📝 Next Steps

1. **Set up Redis** (if you haven't) - See SETUP-REDIS.md
2. **Send test messages** - Populate analytics data
3. **Check dashboard** - Visit /dashboard and view conversation analytics
4. **Monitor trends** - Check weekly for patterns
5. **Iterate** - Use insights to improve Luna's responses

---

## 🤔 Common Questions

**Q: Why is everything showing 0?**
A: You need Redis set up AND users need to have conversations. Analytics only track NEW data after deployment.

**Q: Can I reset analytics?**
A: Yes, but it requires manual Redis key deletion. Best to just track from deployment forward.

**Q: What if keyword matching misses things?**
A: You can add more keywords in `lib/conversation.js` extractStateFromMessages() function.

**Q: How often should I check analytics?**
A: Weekly is good for small projects. Daily if you're actively iterating.

**Q: Can I export this data?**
A: Not built-in yet, but you can access the Redis keys directly using Upstash console or CLI.

---

Your analytics system is now comprehensive and privacy-preserving! 🎉
