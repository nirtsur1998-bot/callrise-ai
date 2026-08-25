# Decision needed — when your calendar and CallRise disagree, who wins?

**One question, three options, ~5 minutes.** Nothing gets built until you answer.
Context: BUG-113 (`remoteUpdatedAt` is written six ways and never compared).

---

## What happens today

Calendar sync is **one-way in practice**, and not in the direction anyone assumes.

- CallRise pushes your changes **out** to Google/Outlook. That works.
- CallRise never pulls their changes **in** for an event it already knows about.

So: your customer moves Tuesday's meeting from 2 pm to 4 pm in their own calendar.
Google now says 4 pm. **CallRise keeps showing 2 pm, permanently.**

And it gets worse on the next edit. If you then change anything at all on that meeting in
CallRise — retitle it, add a note — CallRise pushes its whole copy back, including the stale
2 pm. **Your customer's reschedule is silently overwritten**, and neither of you is told.

There's a smaller tell that the app already disagrees with itself: speaker identity reads the
raw provider data and sees the correct 4 pm, while the calendar screen shows 2 pm.

**Why this is a decision, not a bug fix:** the code has a field (`remoteUpdatedAt`) that was
clearly built to answer "whose copy is newer" — it is stored, sanitised, backed up, and
returned by every push path. Nothing ever *reads* it. Making it work means deciding what
"newer wins" should mean when both sides changed, and that changes what data the app stores.
I'm not guessing that on your behalf.

---

## The three options

### Option A — Remote wins (recommended)
The provider's copy is the truth. If Google says 4 pm, CallRise updates to 4 pm and drops its
own conflicting edit.

- **Good:** matches what people expect. Your customer's calendar is the shared reality; the
  attendees saw the 4 pm update. It is also the simplest thing to explain in one sentence.
- **Cost:** if you edited a meeting offline and the customer edited it too, your edit is lost
  — silently, unless we also show a note.
- **Best for:** meetings other people also control, which is most of them.

### Option B — Last edit wins, whichever side it came from
Compare timestamps. Newest change wins, regardless of who made it.

- **Good:** feels "fair", loses the least work overall.
- **Cost:** genuinely unpredictable in the one case that matters. Clock differences between
  your machine and the provider decide the outcome, and neither party can tell which way it
  went. This is the option that produces "I definitely changed that" support conversations.

### Option C — Never overwrite; flag the conflict and ask
When both sides changed, keep both and show a "this meeting changed in Google — keep yours or
theirs?" prompt.

- **Good:** nothing is ever lost without you knowing.
- **Cost:** the most work to build, and it puts a decision in front of you at a moment you
  probably don't care. Also needs a place to live in the UI.

---

## A separate, smaller question that rides along

Right now, if an event is **deleted in Google** and you later edit your copy in CallRise, the
code sees "the remote is gone" and **re-creates it** — putting a deleted meeting back on your
calendar and everyone else's. That's `404 → recreate`, which is the right handling for "the
remote copy went missing" and the wrong handling for "someone deleted it on purpose", and
today the app cannot tell those apart.

**Whichever option you pick above fixes this too**, because the app will finally know the
remote copy is genuinely gone rather than merely absent. Worth knowing it's in scope.

---

## What I recommend

**Option A**, plus a small one-line notice on the event the first time CallRise pulls a change
in ("updated from Google"). It's the least surprising, the cheapest to build, and the only one
that can be explained to a user in a sentence. Option C is the "correct" answer in the
abstract, and I don't think the conflict happens often enough to earn its complexity — but if
you've personally been bitten by a lost edit, that changes the maths and C becomes right.

**Just reply with A, B, or C.** If A, also say whether you want the "updated from Google"
notice or prefer it silent.
