# Architecture

How a message becomes a reply, where state lives, and what happens when storage
fails.

---

## The request path

Vercel serverless functions keep nothing between invocations. Every inbound
message runs in a process that may have started microseconds ago and may be
destroyed immediately afterwards. Everything Luna "knows" therefore has to be
read from and written back to Redis on every single turn.

```
1.  Twilio POSTs form-encoded parameters to /api/webhook
2.  Verify the X-Twilio-Signature header against TWILIO_AUTH_TOKEN
3.  "forget me"?           -> delete the session, confirm, stop
4.  Load the session from Redis
5.  First contact?         -> send the fixed privacy notice, save, stop
6.  Empty body + media?    -> ask for text, stop
7.  Build the model input: system prompt + user profile + history + new message
8.  Call OpenAI (gpt-4o-mini)
9.  Split the visible reply from the hidden <<<STATE>>> metadata block
10. Detect goals and tips; merge metadata and keyword-derived state
11. Save the session (one write) and record analytics
12. Return TwiML
```

Steps 9–11 are what make the profile accumulate over time rather than resetting.

---

## Two namespaces, one database

| Prefix | Holds | Shape | Expiry |
| --- | --- | --- | --- |
| `luna:<digits>` | One user's conversation and profile | JSON string | `SESSION_TTL_SECONDS`, default 30 days |
| `sw:*` | Aggregate analytics | Counters, hashes, sets, a list | none |

The session key is derived from the phone number with non-digits stripped.
Analytics never store the number itself — only a truncated SHA-256 hash — so the
two namespaces cannot be joined back together.

### Session shape

```jsonc
{
  "messages": [ { "role": "user", "content": "..." } ],   // last 50 kept
  "state": {
    "ageRange": "18-24",
    "mainReason": "trouble falling asleep",
    "severity": "pretty chill",
    "stage": "entry | intake | tailored",
    "language": "en | ar",
    "branchesVisited": [],
    "privacyNoticeSent": true,
    "conversationCount": 3,
    "goals": [],           // suggested actions, with follow-up timestamps
    "tipsGiven": [],       // prevents repeating the same advice
    "sleepPatterns": {}    // bedtime, wake time, duration, environment factors
  },
  "lastActivity": 1750000000000
}
```

### Analytics keys

```
sw:totals:{inbound,outbound,errors,forget_me}
sw:totals:openai_{tokens,input_tokens,output_tokens}
sw:day:<YYYY-MM-DD>              hash of per-day counters
sw:users:<YYYY-MM-DD>            set of hashed users seen that day
sw:demographics:age:<range>
sw:concerns:<reason>
sw:severity:<level>
sw:stage:<stage>
sw:branches:<branch>
sw:language:<en|ar>              and :users, a set for de-duplication
sw:sessions:{new,returning}
sw:goals:{created,completed}     and per-category variants
sw:events                        capped list of the 100 most recent events
```

---

## Cross-language analytics

Luna replies in the user's language, but analytics need consistent categories.
Rather than run a second classification call, the model appends a hidden block
to every reply:

```
<<<STATE>>>{"ageRange":"25-35","mainReason":"anxiety or racing thoughts",
            "severity":"making life hard","branch":"Racing Mind","language":"ar"}<<<END>>>
```

`parseReplyAndState` strips it before anything is shown or stored, and
`stateUpdateFromMeta` accepts only whitelisted values, so a malformed or
adversarial block cannot corrupt state. An English keyword matcher runs as a
fallback and also picks up numeric details such as bedtimes and durations. Where
both produce a value, the model's metadata wins; visited branches are unioned.

---

## Storage failure modes

Storage that is *configured but broken* is more dangerous than storage that is
absent, because the code paths look identical from the outside. Three defences
exist for this:

**1. Per-command timeouts.** Every Redis call is wrapped in a hard timeout
(`REDIS_TIMEOUT_MS`, default 3s). Without one, an unreachable host makes each
call hang until the function is killed.

**2. A circuit breaker.** A single request issues roughly fifteen sequential
Redis commands. Paying the timeout on each still exceeds Twilio's webhook
budget, so after `REDIS_BREAKER_THRESHOLD` consecutive failures the client
short-circuits for `REDIS_BREAKER_COOLDOWN_MS`.

**3. A durability flag.** `getSessionResult` reports whether the answer came
from storage that survives between invocations. The first-contact privacy notice
is only gated on that flag when it is true — otherwise a cold start would look
like a new user and the bot would repeat its intro forever instead of ever
answering. When storage is not durable the notice is sent *alongside* the reply,
so the disclosure still happens and the conversation still moves.

The dashboard reports the outcome as `redis`, `memory`, `redis-unreachable` or
`redis-misconfigured`, based on an actual `PING` rather than on whether a client
object was constructed.

---

## Behaviour with and without Redis

| | With Redis | Without |
| --- | --- | --- |
| Remembers previous messages | yes | no |
| Skips onboarding for returning users | yes | no |
| Avoids repeating tips | yes | no |
| Privacy notice sent once | yes | sent with each cold start's first reply |
| Dashboard counters | accumulate | reset constantly |
| Still answers questions | yes | yes |
