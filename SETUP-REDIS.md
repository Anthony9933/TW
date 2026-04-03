# 🚀 Setting Up Redis for Luna

## What is Redis?
Redis is a database that stores your bot's memory (conversations + analytics) so it survives between messages.

Without Redis: Data resets every few seconds (Vercel serverless functions restart)
With Redis: Data persists forever ✅

---

## Quick Setup (5 minutes)

### Method 1: Vercel Automatic (EASIEST) ⭐

1. Go to https://vercel.com
2. Click your project
3. Click **Storage** tab
4. Click **Create Database** → **Redis**
5. Click **Continue** (picks Upstash automatically)
6. Done! Vercel adds these env vars:
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`

Your code already supports these names! (See lib/analytics.js line 12-14)

### Method 2: Manual Upstash

1. **Create database:**
   - Go to https://console.upstash.com
   - Sign up (free, no card)
   - Click "Create Database"
   - Name: `luna-memory`
   - Region: Choose closest to you
   - Click Create

2. **Copy credentials:**
   - You'll see: `UPSTASH_REDIS_REST_URL`
   - And: `UPSTASH_REDIS_REST_TOKEN`
   - Copy both!

3. **Add to Vercel:**
   - Vercel → Your project → Settings → Environment Variables
   - Add `UPSTASH_REDIS_REST_URL` = (paste URL)
   - Add `UPSTASH_REDIS_REST_TOKEN` = (paste token)
   - Save
   - Go to Deployments → Redeploy

---

## Testing It Works

### Test 1: Send a message
Send "hi" to your WhatsApp bot

### Test 2: Check dashboard
1. Go to: `https://your-app.vercel.app/dashboard`
2. Enter secret: `REDACTED-ROTATED-SECRET`
3. Click "Load"

**Look at bottom right:**
- ✅ Should say: `storage: redis` (good!)
- ❌ If it says: `storage: memory` (Redis not connected)

**Look at the numbers:**
- Should show: 1 inbound, 1 outbound
- If shows: 0 everything (Redis not connected)

### Test 3: Run check script locally
```bash
npm install dotenv @upstash/redis
node check-redis.js
```

This will tell you exactly what's wrong!

---

## How Your Memory Architecture Works

```
WhatsApp User Sends Message
         ↓
    webhook.js
         ↓
    ┌────────────────┐
    │ Conversation   │ → Redis (luna:+1234567890)
    │ Memory         │   Stores: chat history, user state
    └────────────────┘
         ↓
    ┌────────────────┐
    │ Analytics      │ → Redis (sw:totals:*, sw:day:*, sw:events)
    │ Tracking       │   Stores: message counts, tokens, errors
    └────────────────┘
         ↓
    OpenAI API (generates reply)
         ↓
    Save reply to Redis
         ↓
    Send WhatsApp message back
```

**When you open dashboard:**
```
dashboard.html loads
         ↓
    Fetches /api/dashboard-data
         ↓
    dashboard-data.js reads from Redis
         ↓
    Returns: totals, charts, recent events
         ↓
    Dashboard shows your data!
```

---

## Redis Keys Your App Uses

### Conversation Keys (Brain 1)
- `luna:+12345678900` → Full chat history + user state for that phone number
- Expires after 30 days of inactivity
- Used by: lib/conversation.js

### Analytics Keys (Brain 2)
- `sw:totals:inbound` → Total inbound messages (all time)
- `sw:totals:outbound` → Total outbound messages
- `sw:totals:errors` → Total errors
- `sw:totals:forget_me` → Total "forget me" requests
- `sw:totals:openai_tokens` → Total OpenAI tokens used
- `sw:day:2026-04-03` → Today's stats (inbound, outbound, errors, tokens)
- `sw:users:2026-04-03` → Set of unique user hashes for today
- `sw:events` → List of recent events (last 100)
- Used by: lib/analytics.js

---

## Why Two Different Prefixes?

- `luna:` = Conversation memory (personal data, can be deleted)
- `sw:` = Analytics (anonymous counts, kept for stats)

This lets you honor "forget me" requests without losing your analytics!

---

## Troubleshooting

### "Dashboard shows 0 everything"
→ Redis not connected. Check env vars in Vercel.

### "storage: memory"
→ Redis credentials not found. Add to Vercel env vars.

### "Active sessions: —"
→ Normal if no one has chatted recently (sessions expire after 30 days)

### "Unauthorized" on dashboard
→ Wrong DASHBOARD_SECRET. Check .env.example for the secret.

---

## Need Help?

Run: `node check-redis.js` to diagnose Redis connection issues!
