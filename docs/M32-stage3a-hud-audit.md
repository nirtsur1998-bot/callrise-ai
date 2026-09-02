# M32 Stage 3a — the Live Call HUD audit

**Findings only. No HUD code was written.** This is the deliverable the scope
promised: *"walk every live instrument, write down what it displays, what that
display implies, and what the code actually knows."* Severity-ranked, so the
founder picks the 3b subset.

**Run 2026-09-02**, against `main` @ `79ad6de`. Every number below was produced
by executing the real scoring functions on constructed turn buffers — not by
reading the code and reasoning about it.

---

## The lens, and why it landed differently than expected

Stage 1 asked *"what does this key card claim to know?"* and found cards
claiming a credential was fine when nothing had checked it. The same question on
the live screen was expected to find over-precise numbers.

It found something narrower and worse: **two instruments read a data-capture
failure as a fact about the rep's behaviour, and say so on screen, in red,
mid-call.**

That matters more today than it would have yesterday. BUG-D established that
one-sided capture is not rare — 23 calls in the founder's own store, seven of
them on 1 September. The HUD has no idea when it is in that state.

---

## FINDING 1 (HIGH) — the EngagementGauge scores a capture failure as disengagement

`computeEngagementScore` (`useLiveCues.ts:155`) blends talk-balance (40%),
question ratio (30%) and reply pace (30%). Talk-balance is *the rep's share of
words*. On a call where the buyer was never captured, every word is the rep's,
so the share is 100% and balance scores **0**.

Measured — the identical rep audio, scored twice:

| | score | balance | question | pace |
|---|---|---|---|---|
| healthy two-sided call | **81** | 77 | 67 | 100 |
| same rep audio, buyer not captured | **57** | **0** | 100 | 89 |

The rep sees a materially worse engagement reading, during the call, **because
the app failed to record the other side.** Nothing in the gauge's path reads
`channel` — it cannot distinguish "the buyer said nothing" from "the buyer was
never recorded".

The tooltip is honest about the score being approximate. It is not the precision
that is wrong; it is the **attribution**.

## FINDING 2 (HIGH) — the MonologueMeter accuses the rep of talking over a buyer it never recorded

`MonologueTracker.update` walks back to the most recent turn that was *not* the
rep, and calls everything after it the current uninterrupted run. On a one-sided
call there is no such turn, so the run starts at the **first turn of the call**.

| | meter reads | tone |
|---|---|---|
| healthy two-sided call | 0:00 | neutral |
| same rep audio, buyer not captured | **1:57 and climbing** | **high (RED)** |

The label under that number is **"you, uninterrupted"**, and the tooltip reads
*"How long you've been talking without the other side getting a word in."* On a
twelve-minute one-sided call it shows twelve minutes, in red, for the whole
call. The buyer may have been talking throughout.

This is worse than Finding 1: the gauge shows a number that is merely wrong,
while this makes a **specific accusation about the rep's conduct** on the
strength of missing data.

*(It does NOT interrupt — `nudging` is computed and consumed nowhere, and the
tooltip's "never interrupts" is accurate. Checked rather than assumed.)*

## FINDING 3 (MEDIUM) — before the rep is identified, the best case scores like the worst

When `repSpeaker` is null the gauge falls back to *"whichever speaker is more
talkative"*, described in the code as **"a symmetric stand-in — we can't yet
tell which side that is."** It is symmetric arithmetically and not in meaning:

- rep dominating = a pitch, and a real problem;
- buyer dominating = the rep listening, which is the goal of a discovery call.

Both score identically. Measured, a buyer-dominant call with the rep not yet
identified: **score 37, balance 18** — presented to the rep as poor engagement
at the exact moment the call is going well.

`MONOLOGUE_TUNING` already gets this right for its own ratio signal: *"a
discovery call SHOULD be buyer-heavy, and a meter that complains about listening
would be worse than none."* The gauge's fallback contradicts a principle this
codebase has already written down one file away.

## FINDING 4 (LOW) — a placeholder is blended into a displayed number

When there are too few gaps to judge pace, `paceScore` is set to **50** with the
comment *"not enough gaps yet — neutral"*, then blended at 30% into the score
shown. A made-up midpoint contributes to a displayed integer with nothing
marking it. Small, but it is the Stage 1 pattern exactly: an unrepresentable
state rendered as a value.

## FINDING 5 (LOW) — `nudging` is computed and never read

`MonologueState.nudging` is calculated on every update and consumed nowhere
outside its own module. Either it should drive something or it should go; a live
signal that exists and reaches nothing is how the next person concludes a
feature is wired when it is not.

---

## The scope's other two audit targets, already answered — by accident, today

The scope named session-health and *"what does the screen claim when
transcription itself lags"* as targets. Both were hit before this audit started:

- **BUG-177** — the health indicator was gated on `latencyMs !== null`, and
  `latencyMs` is only set when transcript text arrives. **"No audio" and
  "Reconnecting…" could not render on a call that was not transcribing** — the
  readouts were hidden exactly when they applied. Fixed, shipped v1.9.0.
- **BUG-176** — a call could capture almost nothing and say nothing at all. Now
  warned in-call. Fixed, shipped v1.9.0.

So targets 2 and 4 are closed. Targets 1 and 3 are Findings 1–5 above.

---

## What this suggests for 3b — the founder's pick

The three HIGH/MEDIUM findings share one cause: **no live instrument knows
whether the other party is actually being captured.** That fact is already
computed elsewhere (`otherPartyLive`, and v1.9.0's own low-capture notice), so
the fix is plumbing, not new intelligence.

- **3b-1 (recommended)** — make the gauge and the meter *decline to judge* when
  the other party is not being captured, the way the gauge already declines
  before `MIN_TURNS_FOR_ENGAGEMENT`. Not a caveat, not a footnote: no number.
  Stage 1's own posture — an unrepresentable state stays unrepresented.
- **3b-2** — fix the rep-unknown fallback so buyer-dominance is not penalised,
  matching what `MONOLOGUE_TUNING` already says.
- **3b-3** — the two LOW findings, if the above are being touched anyway.

**Deliberately NOT proposed:** any change to what cues say; any outcome-derived
number (the gate is closed and gets no exemption); and any load-reduction or
"quiet mode" work — that is 3c, it is taste, and the scope is explicit that it
needs the founder's read of a real call rather than a guess.

## What the audit does NOT claim

No HUD code has been written. These findings are measured on the scoring
functions in isolation; **none has been reproduced by driving a live call**,
because that needs a real buyer on the other end. The failure mode is derived
from the same functions the app runs, on inputs matching a shape BUG-D shows
occurs regularly — but "the app will show 57" is an inference from its own
arithmetic, not an observation of the running screen.
