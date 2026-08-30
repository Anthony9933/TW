# Luna — WhatsApp sleep & stress support bot

Luna is a bilingual (English / Arabic) WhatsApp chatbot that helps people talk
through sleep and stress problems. It runs as serverless functions on Vercel,
uses Twilio for WhatsApp messaging and OpenAI for replies, and ships with an
operations dashboard for anonymised usage analytics.

It is a support and psychoeducation tool, not a medical or crisis service.

---

## What it does

- **Remembers people.** Conversation history and a lightweight profile (age
  range, main concern, severity, goals, tips already given) are stored per phone
  number, so Luna picks up where it left off instead of restarting every time.
- **Speaks English and Arabic.** It follows whichever language the user writes
  in. The model also emits a hidden, English-only metadata block alongside each
  reply, so analytics stay consistent regardless of conversation language.
- **Discloses before it processes.** Every new user receives a fixed privacy and
  compliance notice as their first message, before any AI call is made.
- **Honours deletion.** Texting "forget me" wipes the stored conversation
  immediately. Sessions also expire automatically after 30 days of inactivity.
- **Escalates safely.** Crisis signals produce hotline information rather than
  advice, and the model is instructed never to diagnose.
- **Reports on itself.** `/dashboard` shows message volume, token spend, funnel
  stages, language split, and — importantly — whether its own storage is healthy.

---

## How it works

```
WhatsApp ──▶ Twilio ──▶ POST /api/webhook
                            │
                            ├─ verify Twilio signature
                            ├─ load session            ─────▶ Redis
                            ├─ first contact? send privacy notice, stop
                            ├─ build messages (system prompt + profile + history)
                            ├─ OpenAI chat completion
                            ├─ split reply from hidden state metadata
                            ├─ update goals / tips / sleep patterns
                            ├─ save session + record analytics  ─▶ Redis
                            └─ return TwiML
```

Serverless functions keep nothing between invocations, so **Redis is what makes
Luna more than a stateless FAQ bot**. Without it every message looks like a
brand-new conversation. See [docs/architecture.md](docs/architecture.md).

### Project layout

```
api/
  webhook.js         Twilio inbound webhook — the whole conversation loop
  dashboard.js       Serves the dashboard HTML
  dashboard-data.js  JSON analytics endpoint (cookie or bearer auth)
  login.js           Dashboard sign-in / sign-out
lib/
  conversation.js    Session storage, reply parsing, state extraction
  luna-prompt.js     Luna's system prompt (identity, flow, language rules)
  privacy-notice.js  The verbatim first-contact disclosure
  analytics.js       Counters, funnels and the dashboard snapshot
  redis-client.js    Unified Redis client: timeouts + circuit breaker
  auth.js            HMAC session cookies for the dashboard
public/
  dashboard.html     Dashboard UI
test/                Test suite (node --test, no extra dependencies)
```

---

## Quick start

Requires Node 18+.

```bash
git clone https://github.com/Ilyas1434/TwilioApp.git
cd TwilioApp
npm install
cp .env.example .env      # then fill it in
npm test
```

To run the functions locally with the Vercel CLI:

```bash
npm run dev
```

Local requests are not signed by Twilio, so set `TWILIO_VALIDATE_SIGNATURE=false`
in `.env` when testing by hand.

---

## Deploying

### 1. Deploy to Vercel

```bash
vercel deploy --prod
```

### 2. Add a Redis database

In the Vercel dashboard: **Storage → Create Database → Redis**, then connect it
to the project. Vercel injects the credentials automatically, including
name-prefixed variants such as `luna_KV_REST_API_URL`, which this app detects.

Any Redis works — set `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or
a single `REDIS_URL` (`redis://` or `rediss://`).

Verify it:

```bash
npm run check:redis
```

### 3. Point Twilio at the webhook

In the Twilio console, set the WhatsApp sender's **incoming message** webhook to:

```
https://<your-app>.vercel.app/api/webhook     (method: POST)
```

Copy it exactly. A trailing space or a missing method silently stops delivery —
Twilio will not call the app and no error appears anywhere in your logs.

Confirm the sender is configured correctly:

```bash
curl -s -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  "https://messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp" \
  | python3 -m json.tool | grep -A3 callback_url
```

---

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | Generates replies |
| `TWILIO_AUTH_TOKEN` | yes | Verifies inbound webhook signatures |
| `TWILIO_VALIDATE_SIGNATURE` | no | Set `false` to skip verification (local only) |
| `TWILIO_WEBHOOK_URL` | no | Override the URL used for signature checks |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | yes\* | Session + analytics storage over HTTP |
| `REDIS_URL` | yes\* | Alternative: a `redis://` / `rediss://` connection string |
| `SESSION_TTL_SECONDS` | no | Conversation lifetime, default `2592000` (30 days) |
| `REDIS_TIMEOUT_MS` | no | Per-command timeout, default `3000` |
| `REDIS_BREAKER_THRESHOLD` | no | Failures before Redis is skipped, default `3` |
| `REDIS_BREAKER_COOLDOWN_MS` | no | How long to skip it for, default `30000` |
| `DASHBOARD_SECRET` | yes | Signs dashboard cookies; also a bearer token |
| `DASHBOARD_USERNAME` / `_PASSWORD` | yes | Dashboard sign-in |

\* One storage option is required. Without either, Luna still replies but
remembers nothing between messages.

---

## Operations dashboard

Visit `/dashboard` and sign in with `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`.
Scripts can use the JSON endpoint directly:

```bash
curl -H "Authorization: Bearer $DASHBOARD_SECRET" \
  https://<your-app>.vercel.app/api/dashboard-data
```

The `storage` field is the first thing to check when something looks wrong:

| Value | Meaning |
| --- | --- |
| `redis` | Healthy. |
| `memory` | No database configured. Nothing is remembered between messages. |
| `redis-unreachable` | Credentials exist but the database does not answer. |
| `redis-misconfigured` | Credentials are present but malformed. |

---

## Testing

```bash
npm test
```

The suite runs against the real handler with stubbed OpenAI and Redis clients,
and covers each storage state explicitly — healthy, absent, and configured but
dead — plus signature verification, media-only messages and reply parsing. No
test dependencies beyond Node's built-in runner.

---

## Troubleshooting

**Luna repeats her intro message and never answers.**
The session store is not working, so every message looks like first contact.
Check `storage` on `/api/dashboard-data` and run `npm run check:redis`. The
usual cause is a deleted database whose credentials are still configured.

**Nothing reaches the app at all.**
Check the webhook URL registered on the WhatsApp sender for typos, stray
whitespace, and a missing `POST` method. Then confirm the endpoint is reachable:

```bash
curl -i -X POST https://<your-app>.vercel.app/api/webhook
```

A `403` means the app is up and rejecting an unsigned request — which is
correct. A `405` means you sent a `GET`.

**Everything returns 403.**
Signature verification is failing. The URL Twilio signs must match the one the
app reconstructs; set `TWILIO_WEBHOOK_URL` to pin it explicitly.

**The dashboard shows zeros.**
Analytics live in the same Redis instance as conversations. If `storage` is not
`redis`, counters cannot persist.

---

## Privacy and safety

- Phone numbers are the session key; in analytics they are SHA-256 hashed and
  truncated, so stored metrics are not linkable back to a person.
- Conversations expire after 30 days of inactivity and can be deleted on demand
  with "forget me".
- The privacy notice is fixed text, never model-generated, so the disclosure
  cannot drift from what the app actually does.
- Luna is explicitly instructed not to diagnose, and to hand off to crisis
  resources (988, and HOME to 741741) rather than counsel through a crisis.

If you deploy this, keep the notice accurate for your own deployment.

---

## License

MIT — see [LICENSE](LICENSE).
