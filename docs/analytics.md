# Analytics

What the dashboard measures, where each number comes from, and what it can and
cannot tell you.

Everything here is aggregate. No message content is ever stored in the analytics
namespace, and phone numbers appear only as a truncated SHA-256 hash.

---

## Volume and cost

| Metric | Source |
| --- | --- |
| Inbound / outbound messages | Incremented per webhook call and per successful reply |
| Errors | Incremented when the handler falls into its catch block |
| "Forget me" requests | Incremented on deletion |
| Token usage | `usage` from each OpenAI response, split into input and output |
| Estimated cost | Input and output tokens priced separately at `gpt-4o-mini` rates |

The cost figure uses the real input/output split. Totals recorded before that
split existed fall back to a blended rate, so historical numbers stay roughly
comparable rather than jumping.

---

## Conversation metrics

**Demographics** — age range, one of `under 13`, `13-17`, `18-24`, `25-35`,
`36+`. Counted once per user, the first time it is established.

**Concerns** — the main reason someone came: trouble falling asleep, waking
during the night, anxiety or racing thoughts, or general curiosity.

**Severity** — self-reported impact: pretty chill, bothering me a while, or
making life hard. Drives whether Luna includes an escalation prompt.

**Funnel stages** — `entry` → `intake` → `tailored`. A user reaches `tailored`
once age, reason and severity are all known. The drop-off between `entry` and
`intake` is the clearest signal that onboarding is too heavy.

**Branches** — which specialist topics conversations actually reach (Bedtime
Routine, Racing Mind, Sleep Schedule, and so on). Useful for spotting content
gaps: a branch that is never reached is either irrelevant or unreachable.

**New vs returning** — counted per session start. Returning users are the
honest measure of whether the bot is useful; total message count is not.

**Languages** — English or Arabic, de-duplicated per user via a Redis set, so
this reflects distinct people rather than message volume.

**Goals** — actions Luna suggested and whether they were later marked complete,
broken down by category.

---

## Where the classifications come from

Two sources are merged for every turn:

1. A hidden metadata block the model appends to each reply, classified in
   canonical English regardless of the conversation's language. This is the
   primary path and the reason Arabic conversations produce usable analytics.
2. An English keyword matcher over the raw text, which backstops a missing block
   and additionally extracts numeric details such as bedtimes and durations.

Only whitelisted values are accepted. Unrecognised categories are dropped rather
than recorded, so the totals stay clean at the cost of occasionally undercounting.

---

## Reading the dashboard honestly

- **`storage` comes first.** If it is not `redis`, every counter below it is
  meaningless — they cannot persist between requests. See
  [architecture.md](architecture.md).
- **Counters are cumulative and never expire.** Sessions expire after 30 days;
  the aggregate counters do not. A user who has been deleted still appears in
  historical totals as an anonymous hash.
- **Branch counts include Luna's own wording.** Branch detection matches the
  assistant's text as well as the user's, so a branch can register when Luna
  raises a topic rather than when the user does.
- **Unique users are per-day sets.** The 7-day figure is a union of those sets,
  so someone who messages on three days counts once.

---

## Access

The dashboard UI is at `/dashboard`, behind `DASHBOARD_USERNAME` and
`DASHBOARD_PASSWORD`. The raw JSON is available for scripting:

```bash
curl -H "Authorization: Bearer $DASHBOARD_SECRET" \
  https://<your-app>.vercel.app/api/dashboard-data
```

Sign-in issues a self-verifying HMAC cookie signed with `DASHBOARD_SECRET`, so
rotating that secret signs everyone out.
