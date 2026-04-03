# 🚨 START HERE - Fix Your Dashboard in 5 Minutes

## The Problem (In Plain English)

Your bot forgets everything because it has amnesia.

Every time someone sends a message:
1. Bot wakes up 😴
2. Processes message 🧠
3. Falls asleep 💤
4. **FORGETS EVERYTHING** 💀

So your dashboard shows 0 because the bot forgot it ever got messages.

---

## The Solution (One Word)

**Redis** = A notebook where the bot writes everything down so it doesn't forget.

---

## How to Fix (5 Minutes)

### Option 1: Vercel Auto-Setup (EASIEST) ⭐

1. Open browser → https://vercel.com
2. Click your Luna project
3. Click **"Storage"** tab (top of page)
4. Click **"Create Database"**
5. Click **"Redis"**
6. Click **"Continue"** (it picks Upstash for you)
7. Done! ✅

Now redeploy:
- Click **"Deployments"** tab
- Click the top deployment → **"Redeploy"** button

### Option 2: Manual Setup (If Option 1 didn't work)

**Part 1: Create Redis database**
1. Go to: https://console.upstash.com
2. Click: **"Sign Up"** (free, no credit card)
3. Click: **"Create Database"**
4. Type name: `luna-memory`
5. Click: **"Create"**

You'll see two things - COPY THESE:
- `UPSTASH_REDIS_REST_URL` (looks like https://xxx.upstash.io)
- `UPSTASH_REDIS_REST_TOKEN` (long random string)

**Part 2: Add to Vercel**
1. Go to: https://vercel.com → your project
2. Click: **"Settings"** → **"Environment Variables"**
3. Add first variable:
   - Name: `UPSTASH_REDIS_REST_URL`
   - Value: (paste the URL you copied)
   - Click "Add"
4. Add second variable:
   - Name: `UPSTASH_REDIS_REST_TOKEN`
   - Value: (paste the token you copied)
   - Click "Add"
5. Click **"Deployments"** → top deployment → **"Redeploy"**

---

## Testing It Works

### Test 1: Send a message
Text your bot: "hi"

### Test 2: Check dashboard

1. Go to your app URL + `/dashboard`
   - Example: `https://your-app.vercel.app/dashboard`

2. Enter this secret:
   ```
   REDACTED-ROTATED-SECRET
   ```

3. Click **"Load"**

4. Look at **bottom right** of page:
   - ✅ **"storage: redis"** = IT WORKS!
   - ❌ **"storage: memory"** = Redis not connected

5. Look at the numbers:
   - Should show: **1 inbound, 1 outbound**
   - If shows **0 everything** = Redis not connected

---

## What Each File Does

```
TwilioApp/
├── api/
│   ├── webhook.js          ← Receives WhatsApp messages
│   └── dashboard-data.js   ← Dashboard fetches data from here
├── lib/
│   ├── conversation.js     ← Brain #1: Chat history + user state
│   ├── analytics.js        ← Brain #2: Message counts + dashboard data
│   └── luna-prompt.js      ← Luna's personality
├── public/
│   └── dashboard.html      ← Dashboard UI (what you see in browser)
├── .env.example            ← Shows what environment variables you need
├── vercel.json             ← Config: makes /dashboard work
│
├── SETUP-REDIS.md          ← Full Redis setup guide
├── ARCHITECTURE.md         ← How everything connects (diagrams!)
└── START-HERE.md           ← You are here! 👋
```

---

## Quick Answers

**Q: What is Redis?**
A: A database that lives in the cloud. Your bot writes stuff there so it doesn't forget.

**Q: Do I have to pay?**
A: No! Upstash has a free tier that's plenty for a personal bot.

**Q: Will my old messages show up in the dashboard?**
A: No - only NEW messages after you set up Redis. Old ones are gone (they were never saved).

**Q: Why do I need TWO environment variables?**
A: One is the address (URL), one is the password (TOKEN). Both needed.

**Q: What's the DASHBOARD_SECRET for?**
A: So random people can't see your analytics. Only people with the secret can view the dashboard.

**Q: Where's my Vercel project URL?**
A: Vercel dashboard → your project → click the domain (top of page)

**Q: I did everything but dashboard still shows 0**
A:
1. Check you **redeployed** after adding env vars
2. Send a **NEW message** to your bot (old ones don't count)
3. **Refresh** the dashboard
4. Check it says **"storage: redis"** not "storage: memory"

---

## Need More Help?

1. Read **ARCHITECTURE.md** for diagrams explaining how it all works
2. Read **SETUP-REDIS.md** for detailed setup steps
3. Run `node check-redis.js` to diagnose connection issues

---

## One More Thing

Your code already has Redis support built in! You (or someone) "vibe coded" it perfectly.

All the Redis logic is already there in:
- `lib/conversation.js` (lines 20-37)
- `lib/analytics.js` (lines 10-24, 80-124)

You just needed to flip the switch by adding the credentials! 🎉
