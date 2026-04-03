# 🏗️ Luna Memory Architecture (Simple Explanation)

## The Full Flow (When Someone Messages Your Bot)

```
┌─────────────────────────────────────────────────────────────────┐
│  User sends WhatsApp message: "I can't sleep"                  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Twilio receives message → forwards to your webhook             │
│  POST https://your-app.vercel.app/api/webhook                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  api/webhook.js starts processing                               │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                    ┌─────────┴─────────┐
                    ↓                   ↓
        ┌───────────────────┐   ┌──────────────────┐
        │ 📊 ANALYTICS      │   │ 🗣️ CONVERSATION  │
        │                   │   │                   │
        │ recordInbound()   │   │ getSession()     │
        │   ↓               │   │   ↓              │
        │ Redis:            │   │ Redis:           │
        │ sw:totals:inbound │   │ luna:+1234567890 │
        │ sw:day:2026-04-03 │   │                  │
        │ sw:events         │   │ Returns:         │
        │                   │   │ - messages[]     │
        │ Increments:       │   │ - state{}        │
        │ ✅ +1 inbound     │   │ - lastActivity   │
        └───────────────────┘   └──────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Build OpenAI request                                           │
│  - System prompt (Luna personality)                             │
│  - User profile (age, concerns, severity) ← from state          │
│  - Chat history ← from messages[]                               │
│  - New user message                                             │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Call OpenAI API                                                │
│  Returns: "Hey! I hear you. Can't sleep, huh? What's going..."  │
│  Usage: { total_tokens: 324 }                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                    ┌─────────┴─────────┐
                    ↓                   ↓
        ┌───────────────────┐   ┌──────────────────┐
        │ 📊 ANALYTICS      │   │ 🗣️ CONVERSATION  │
        │                   │   │                   │
        │ recordOutbound()  │   │ appendMessage()  │
        │   ↓               │   │   ↓              │
        │ Redis:            │   │ Redis:           │
        │ sw:totals:        │   │ luna:+1234567890 │
        │   outbound +1     │   │                  │
        │   tokens +324     │   │ Saves:           │
        │ sw:day:2026-04-03 │   │ - user message   │
        │   outbound +1     │   │ - assistant msg  │
        │   tokens +324     │   │ - updated state  │
        └───────────────────┘   └──────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Extract state updates from conversation                        │
│  - Did they mention age? → state.ageRange                       │
│  - Main concern? → state.mainReason                             │
│  - Severity? → state.severity                                   │
│  - Conversation stage? → state.stage                            │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Send reply back via Twilio                                     │
│  User receives: "Hey! I hear you. Can't sleep, huh?..."         │
└─────────────────────────────────────────────────────────────────┘
```

---

## When You Open the Dashboard

```
┌─────────────────────────────────────────────────────────────────┐
│  You visit: https://your-app.vercel.app/dashboard              │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Browser loads: public/dashboard.html                          │
│  Shows: input for secret, "Load" button                        │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  You enter: 9e2d66c65b2f60198e8f62d22dfa9b7538818323bf...      │
│  Click: "Load"                                                  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  JavaScript fetches: /api/dashboard-data                       │
│  Headers: Authorization: Bearer YOUR_SECRET                     │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  api/dashboard-data.js runs                                     │
│  - Checks secret ✅                                              │
│  - Calls getDashboardSnapshot()                                 │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  lib/analytics.js: getDashboardSnapshot()                       │
│                                                                 │
│  Reads from Redis:                                              │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ sw:totals:inbound      → 42                               │ │
│  │ sw:totals:outbound     → 41                               │ │
│  │ sw:totals:errors       → 0                                │ │
│  │ sw:totals:forget_me    → 1                                │ │
│  │ sw:totals:openai_tokens → 15,234                          │ │
│  │                                                           │ │
│  │ For last 14 days:                                         │ │
│  │ sw:day:2026-04-03 → { inbound: 5, outbound: 5, ... }     │ │
│  │ sw:day:2026-04-02 → { inbound: 12, outbound: 11, ... }   │ │
│  │ ...                                                       │ │
│  │                                                           │ │
│  │ Unique users (last 7 days):                               │ │
│  │ sw:users:2026-04-03 → [hash1, hash2, hash3]              │ │
│  │ sw:users:2026-04-02 → [hash1, hash4]                     │ │
│  │ ...                                                       │ │
│  │                                                           │ │
│  │ Recent events:                                            │ │
│  │ sw:events → [{ts, type: "inbound", user}, ...]           │ │
│  │                                                           │ │
│  │ Active sessions:                                          │ │
│  │ Scans Redis for: luna:* keys → counts them               │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  Returns JSON:                                                  │
│  {                                                              │
│    totals: { inbound: 42, outbound: 41, ... },                 │
│    today: { inbound: 5, outbound: 5, ... },                    │
│    series_14d: [ {date, label, inbound, outbound}, ... ],      │
│    unique_users_7d: 8,                                          │
│    active_sessions_redis: 3,                                    │
│    recent_events: [ ... ],                                      │
│    storage: "redis" ✅                                          │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Dashboard renders:                                             │
│  - KPI cards (totals, today's stats)                           │
│  - 14-day chart (bar graph)                                    │
│  - Recent activity table                                       │
│  - Status: "storage: redis" ✅                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## What Happens WITHOUT Redis? ❌

```
User sends message
    ↓
webhook.js runs (Serverless Function Instance #1)
    ↓
Saves to IN-MEMORY:
    memory.totals.inbound = 1
    memory.daily.set("2026-04-03", {inbound: 1})
    memory.events.push({type: "inbound"})
    ↓
Function finishes → Instance #1 DESTROYED
    ↓
IN-MEMORY DATA DELETED 💀

────────────────────────────────────────

You open dashboard
    ↓
dashboard-data.js runs (Serverless Function Instance #2 - FRESH!)
    ↓
Reads from IN-MEMORY:
    memory.totals.inbound = 0  ← Empty! Fresh instance!
    memory.daily = new Map()   ← Empty!
    memory.events = []         ← Empty!
    ↓
Returns:
{
  totals: { inbound: 0, outbound: 0 },
  storage: "memory" ❌
}
    ↓
Dashboard shows: 0 everything 😢
```

**Why?** Vercel serverless functions don't share memory. Each API call = new instance = fresh RAM.

---

## What Happens WITH Redis? ✅

```
User sends message
    ↓
webhook.js runs (Instance #1)
    ↓
Saves to REDIS:
    redis.incr("sw:totals:inbound") → 1
    redis.hincrby("sw:day:2026-04-03", "inbound", 1)
    redis.lpush("sw:events", {...})
    ↓
Function finishes → Instance #1 destroyed
    ↓
BUT! Data stays in Redis ✅

────────────────────────────────────────

You open dashboard (5 minutes later)
    ↓
dashboard-data.js runs (Instance #2)
    ↓
Reads from REDIS:
    redis.mget("sw:totals:inbound") → 1 ✅
    redis.hgetall("sw:day:2026-04-03") → {inbound: 1} ✅
    redis.lrange("sw:events") → [{type: "inbound"}] ✅
    ↓
Returns:
{
  totals: { inbound: 1, outbound: 1 },
  storage: "redis" ✅
}
    ↓
Dashboard shows: YOUR DATA! 🎉
```

**Why?** Redis is a separate database that lives outside your serverless functions. It's always there, always remembers.

---

## Redis = Shared Brain

```
┌─────────────────────────────────────────────────────────┐
│                      REDIS DATABASE                     │
│                   (Lives in the cloud)                  │
│                                                         │
│  luna:+1234567890 → {messages, state, lastActivity}    │
│  sw:totals:inbound → 42                                 │
│  sw:totals:outbound → 41                                │
│  sw:day:2026-04-03 → {inbound: 5, outbound: 5}         │
│  sw:events → [{type: "inbound"}, ...]                   │
│                                                         │
└─────────────────────────────────────────────────────────┘
           ↑                    ↑                    ↑
           │                    │                    │
     ┌─────┘              ┌─────┘              ┌─────┘
     │                    │                    │
┌─────────┐         ┌─────────┐         ┌─────────┐
│Instance1│         │Instance2│         │Instance3│
│webhook  │         │dashboard│         │webhook  │
└─────────┘         └─────────┘         └─────────┘
 (destroyed)         (destroyed)         (destroyed)

All instances READ and WRITE to the same Redis database!
```

---

## Key Takeaways

1. **Without Redis:** Each serverless function has its own memory (lost when function ends)
2. **With Redis:** All functions share one database (data persists forever)
3. **Your code already supports Redis!** Just need to add credentials
4. **Two memory systems:**
   - Conversation memory (`luna:*`) - chat history, user state
   - Analytics memory (`sw:*`) - counts, charts, dashboard data

---

## Next Step

Follow SETUP-REDIS.md to add Redis in 5 minutes! 🚀
