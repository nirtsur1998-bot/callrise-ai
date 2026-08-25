# Decision needed — how should CallRise tell you a meeting didn't reach your calendar?

**One question, three options, ~5 minutes.** Nothing gets built until you answer.
Context: BUG-112.

---

## What happens today

You create a meeting in CallRise with two-way sync on. The push to Google or Outlook fails —
an expired token, a permissions error, the provider having a bad day.

**The event sits in your CallRise calendar looking completely normal.** It is not on your real
calendar. It is not on your phone. No reminder will fire. There is no toast, no badge, no
icon, nothing in the Activity Center, and no log line you could reach.

You find out when you don't show up to the meeting.

### The part worth knowing

The code has a confident comment explaining why this deliberately isn't a background job.
Two of its three reasons are sound. The third reads:

> *"a failure already surfaces ON THE EVENT ITSELF in the Calendar UI via sync.state — which is
> a far better place for it than a generic Activity Center row."*

**That surface was never built.** Across the entire app front-end, the field it names appears
exactly once — in a type definition. The calendar grids never mention it. Nothing reads it,
ever.

So the argument for having no failure UI rests on a failure UI that doesn't exist. I've
already corrected the comment (it was actively misleading the next person to open that file).
**What I have not done is decide where the failure should actually appear** — that's a product
call about your app's voice and your users' attention, and it's yours.

Two related paths have the same silence: deleting a synced event reports success *before* the
remote delete is even attempted, and a revoked token leaves the Settings screen saying
"Connected · Two-way sync on" indefinitely while every event retries forever.

---

## The three options

### Option A — A quiet marker on the event itself (recommended)
A small warning dot or "not synced" chip on the event in the calendar grid, with the reason on
click and a "Try again" button.

- **Good:** the information lives exactly where the problem is. You see it while looking at
  your week, which is when it matters. This is what the original comment intended — it just
  needs building.
- **Cost:** it's per-event, so a broad failure (dead token) paints a lot of dots without ever
  telling you the one useful thing: *your connection is broken.*

### Option B — One banner when the connection itself is broken
Skip per-event marks. Detect "the provider is refusing us" and show a single banner —
"Google Calendar disconnected — meetings aren't syncing. Reconnect." — plus fixing the
Settings screen so it stops claiming Connected.

- **Good:** one message, one action, addresses the cause rather than each symptom. Covers the
  large majority of real failures, which are auth expiry rather than one-off errors.
- **Cost:** a genuinely isolated failure (one event rejected, connection fine) stays silent.

### Option C — Both
Banner for connection-level failures, per-event marker for isolated ones.

- **Good:** complete.
- **Cost:** roughly double the work, and two surfaces to keep honest. Given this bug exists
  *because* a claimed surface was never built, adding two is worth a moment's thought.

---

## What I recommend

**Option B first, then A if it still feels needed.**

The reasoning: the failure that actually costs you a meeting is the connection dying, because
it's silent, persistent, and affects *every* event from then on. It also has a clear fix the
user can perform. Per-event dots are more precise but they ask you to notice something small,
on a screen you scan quickly, for a problem you can't act on individually.

B also repairs the "Connected · Two-way sync on" lie, which is doing real damage on its own —
it's the reason nobody reconnects.

**Just reply with A, B, or C.** If B, one sub-question: when the connection breaks, should
CallRise stop accepting new synced events (fail loudly at creation), or keep taking them and
sync when reconnected? I'd suggest the latter, with the banner visible.
