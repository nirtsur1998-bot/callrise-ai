# M32 Stage 3 — the Live Call HUD: SCOPE, not code

**Nothing here is built.** This is the scope brought for approval, per the
convention set at Stage 2. Decisions the founder owns are marked **DECISION**.

The milestone's own words: Stage 3 is *"the screen watched during the most
stressful minutes of the day, and the one surface M31 never touched."*

---

## What the live screen is today (surveyed, not remembered)

`src/renderer/src/features/live/LiveView.tsx` (1,176 lines) renders, during a
call: a **MustAskStrip** (checklist), **Waveform**, **EngagementGauge** (a
score), **MonologueMeter**, the **TranscriptView**, a **SuggestionRail**, an
interrupting **CueCard**, **AskCoach**, and **battlecards** in the rail. Plus
session-health notices, cue latency tracking, auto-stop, and clip bookmarks.

That is *nine instruments* on the screen watched under the most stress. The
M31 redesign never touched it; the M24 deal-intelligence work added to it.

---

## Applying the milestone's lens: what does this screen CLAIM?

Stage 1 asked "what does the key card claim to know?" Stage 3 should ask the
same of every live instrument, because mid-call is the worst possible place to
show a number the app cannot stand behind:

1. **EngagementGauge shows a score.** Computed from what, at what confidence,
   how early in a call is it meaningful? A gauge at minute one claims
   precision it cannot have. *(Audit target — same shape as the status dot.)*
2. **Session-health / cue latency.** When cues silently degrade (slow AI,
   dropped audio), does the screen SAY so, or do cues just stop while the rep
   assumes coverage? A silent instrument failing mid-call is the hollow-green
   thesis live. *(Audit target.)*
3. **MonologueMeter, MustAskStrip** — same question, likely healthier (they
   compute from the transcript the rep can see).
4. **What does the screen claim when transcription itself lags?** The founder
   discovered BUG-146 mid-call. The screen's behaviour during degraded
   transcription is the trust question with the highest stakes in the app.

**Proposed Stage 3a: the audit, no code.** Walk every live instrument, write
down what it displays, what that display implies, and what the code actually
knows. Severity-ranked findings doc — the Stage 1 method on the live screen.
Cheap (a day), and it decides everything after it.

---

## Candidate work after the audit (not commitments)

- **3b — honesty fixes:** whatever 3a finds. Pattern from Stage 1: unrepresentable
  states over caveats; "not checked" over green.
- **3c — load reduction:** nine instruments compete for attention under stress.
  Candidates: a "quiet mode" showing only transcript + must-ask; cue frequency
  caps surfaced as a visible setting. **DECISION** — this is taste + how the
  founder actually uses the screen; needs their read of a real call, not my
  guess.
- **3d — the Stage 2 tie-in, stated honestly: mostly NOT yet.** Outcome data
  now exists, but the gate is closed and will stay closed for months. The HUD
  must not surface "what wins calls" claims the gate refuses to make. The one
  gate-independent candidate: on a call linked to a deal, show that deal's own
  facts (stage, last outcome reason for this contact) — records, not analysis.
- **3e — reason prompt at call end:** when a call ends on a deal-linked
  contact, the post-call screen could offer the same optional reason capture.
  Same skippability rules. Small.

## What Stage 3 should NOT do

- No live AI coaching expansion (M24 owns nudge content; this stage is about
  whether the existing screen tells the truth and stays usable).
- No gate bypass: nothing on the HUD may show outcome-derived numbers while
  the gate says insufficient — the import-graph test already enforces this
  structurally, and the HUD gets no exemption.

---

## Sequencing + the honest end

3a (audit) → founder reads findings → picks 3b/3c/3d/3e subset. The milestone
*"can end honestly at any stage boundary"* — including right after 3a with a
findings doc and zero HUD code, if the findings say the screen is healthier
than assumed.

**DECISION needed to start: approve 3a as scoped, or redirect.**
