# M34 Stage 2 — HUD proposals 3c and 3d (propose, don't build)

Revised 2026-09-04 by the session the founder kept, on top of the first draft
from the parallel session (`d4c195f`). **No code written.** The first draft's
taxonomy (interrupting vs glanceable) and its 3c-A recommendation survive; what
changed is that both proposals now answer the founder's actual questions —
*what is on the screen mid-call, what can a person absorb while talking, what
would quiet mode hide versus keep; and for 3d, the one or two things worth
glancing at mid-sentence* — from the surveyed surface rather than from the
component list, and 3d now proposes what the founder named (stage, risk tier,
last call) instead of what the scope doc happened to mention.

Everything below is read from source on this date (`LiveView.tsx`,
`useLiveCues.ts`, `monologue.ts`, `MustAskStrip.tsx`, `SuggestionRail.tsx`,
`DealIntelligencePanel.tsx`, `contextFusion.ts`, `chipContext.ts`,
`prep-brief.ts`). Nothing here was observed on a real call — the founder's
read of one is the decision input, as the scope said.

---

# 3c — load reduction

## What is actually on the screen mid-call

Twelve things, once a call is running with a transcript. Grouped by what they
cost the rep, which is the only grouping that matters for load.

| # | element | what it shows | when it changes | cost |
|---|---|---|---|---|
| 1 | **TranscriptView** | the words, both sides, live | every partial (~300 ms) | glance — and the one thing a rep actually watches, because it is also the proof capture is working |
| 2 | **MustAskStrip** | 5 pills: Budget, Timeline, Decision process, Competition, Success criteria; covered ones go muted | when a topic is detected | glance — designed as "the quietest thing on the screen", outstanding items stay bold |
| 3 | **Waveform** | mic level | continuous | ambient; peripheral vision only |
| 4 | **StatusBadge + session-health notice** | listening / paused; "No audio", "Reconnecting…" | on state change | **must always be visible** — BUG-177 was this hidden exactly when it applied |
| 5 | **OtherPartyControl** | consent state for recording the other side | rarely | must stay reachable (consent) |
| 6 | **CueControls** | cues on/off, sensitivity low/medium/high | never on its own | a control, not a readout |
| 7 | **EngagementGauge** | 0–100 "approx." ring, pulsing dot | recomputed per turn | a read — a number that invites interpretation mid-sentence |
| 8 | **MonologueMeter** | your current uninterrupted run, tone neutral→warn→red | every second while you talk | a read that turns red WHILE you are talking, i.e. at the moment you cannot act on it |
| 9 | **CueCard** (interrupt tier) | one deterministic cue — pace, battlecard, objection — pops in the corner, auto-dismisses after 10 s | at most one per 20/30/45 s by sensitivity | **interrupt** — designed to be, lands in ~400 ms |
| 10 | **SuggestionRail** (slow tier) | model-generated: discovery, next-question, buying-signal, objection, battlecard; stacks, waits to be read | 1.5–2.5 s after the moment | a read that accumulates — the rail grows until dismissed |
| 11 | **DealIntelligencePanel** (M24, beta) | health score + trajectory, rare nudges, "Watching" quiet state | per nudge; quiet grace window | a read; its own quiet/balanced/aggressive already exists |
| 12 | **AskCoach** bar | a text box to ask the coach | never on its own | a control |

Two floating stacks (cue column right, DI panel left) reserve transcript width
and height while visible, so the transcript — the thing the rep watches — gets
narrower exactly when the screen gets busier.

## What a person can absorb while talking

Talking is a full-attention task. What survives it, from how the elements are
built rather than from a theory of attention:

- **A fixed-position state that can be checked in under a second** — the
  transcript still scrolling (capture alive), the strip's bold pills (what is
  still unasked), the status badge (no audio / reconnecting). These are checked
  between sentences and answered by position and colour, not by reading.
- **One interrupt at a time, if it is deterministic and short.** The cue
  channel was built for exactly this and already enforces one slot, a hard
  cooldown, and a 10-second auto-dismiss. Whether even one is too many is the
  founder's call from a real call; the mechanism is right.
- **Not absorbable while talking:** a number that asks to be interpreted (the
  gauge), a warning that arrives during the act it warns about (the meter goes
  red while you are mid-run), and a stack that grows (the rail). These are
  read between turns or not at all, and while unread they cost transcript
  width.

So the load question is not "which instruments are wrong" — 3a answered that —
but **which ones are for between-turn reading and are currently rendered as if
they were for mid-sentence glancing.** Elements 7, 8, 10, 11 are between-turn
instruments occupying mid-sentence space.

## What quiet mode hides versus keeps

**Keep, always:** 1 transcript, 2 must-ask strip, 3 waveform, 4 status/health
(non-negotiable — a capture failure must be visible in every mode), 5 consent
control, 12 Ask-coach bar (inert until used).

**Hide in quiet mode:** 7 gauge, 8 meter, 10 rail (collapsed to a count the rep
can expand), 11 DI panel (collapsed to its quiet dot or hidden).

**The open question inside quiet mode — the interrupt cue (9).** A quiet mode
that still pops a card is not quiet; a quiet mode that silences the one channel
built to be fast and rare throws away the product's differentiator. Two
readings, and this is the founder's call from a real call:

- *quiet = no interrupts at all* — the rep asked for silence; give it. Cues off
  is already a switch (`CueControls.enabled`), so quiet mode composes with it.
- *quiet = no reading, interrupts allowed* — hide everything that must be read,
  keep the one thing that taps you on the shoulder.

Recommendation: **quiet keeps the interrupt cue** (reading is the load, not the
tap), with the existing cues toggle beside it for a rep who wants total silence.
Two switches, both already meaningful, no third state to explain.

## The options

- **3c-A (recommended) — one "Quiet" toggle in the live header, live,
  reversible mid-call.** On: the hide list above; off: today's screen. Persists
  as one setting (last state wins next call). Hides, never unmounts, so the
  instruments keep computing and reappear instantly with current state. The
  scope's own candidate, and the only option that lets the founder find the
  answer *on* a call rather than predict it in Settings.
- **3c-B — quiet by default, "Show instruments" to reveal.** Same hide list,
  opposite default. Better for a new user's first call (they meet the screen
  at its calmest); worse for the founder, who built the instruments and knows
  them. A default is a product decision, so it is listed, not recommended — but
  if 3c-A is used on real calls and the founder finds quiet is where they live,
  flipping the default is a one-line follow-up.
- **3c-C — automatic quiet while you are talking.** Hide the between-turn
  instruments whenever `monologue.ts` says the rep is mid-run, show them when
  the buyer is speaking or in silence. Tempting because it needs no switch.
  **Recommended against:** it adds motion — things appearing at every turn
  boundary — and motion is a cost of the same kind it is trying to remove. It
  also depends on speaker attribution, which BUG-D and BUG-172 show is not yet
  reliable enough to drive layout.
- **3c-D — per-instrument show/hide in Settings.** The first draft's 3c-B.
  Recommended against for the reason the scope gave: it makes the rep
  configure the screen away from a call.

**Separately decidable — the cue-frequency cap.** "At most one cue every N
seconds", surfaced in `CueControls`. Today the cooldown is fixed per
sensitivity (20/30/45 s) and invisible; the rep cannot see or set the pace.
Cost flagged honestly: this is a small new mechanism plus a setting, not an
exposed knob (the first draft called it "already paces" — it does not; there is
a cooldown on the interrupt channel and nothing feeds it). Worth it if quiet
mode keeps interrupts; pointless if quiet mode silences them.

**Cost of 3c-A:** a header toggle, one persisted boolean, conditional render on
props the elements already receive, the rail's collapsed-count state. Days.
Nothing in the cue engine, nothing in the instruments' arithmetic.

**Explicitly not proposed:** removing an instrument for everyone; a layout
redesign; touching what cues say (M24 owns that).

**DECISIONS for the founder:** A or B as the default; whether quiet keeps the
interrupt cue; whether the frequency cap is wanted at all.

---

# 3d — deal facts on the HUD

## What the app knows on a live call, and how

A live call knows its contact and deal **only through a matched calendar
meeting** (`currentMeeting.contactId` / `.dealId`, the same link
`contextFusion.ts` uses to ground Deal Intelligence). No meeting match, no
link — and 3d must not invent one from a name (the backfill refused that for the
same reason: unattributable context is worse than none). So 3d appears on
matched-meeting calls and is absent otherwise, exactly like a calendar chip.

The precedent is the calendar chip (`chipContext.ts`, M31 Slice B): *every
field optional, only ever set from data we actually have, an absent field
renders nothing.* And its risk marker is routed through `dealAttentionTier` so
"risk" means one thing across the app. 3d should reuse both.

## The founder's three, and which are records

| the founder named | what the app holds | record or analysis |
|---|---|---|
| **deal stage** | `deal.stageId` → the stage's label ("Proposal") | record, the rep set it |
| **risk tier** | `deal.riskAssessment.level`, produced by M24 on the rep's request and stored with its date; the chip shows only the two risk tiers via `resolveRisk` | a **stored** assessment — AI-written when the rep asked for it, not computed live, not outcome-derived. The gate ban is on outcome-derived numbers; this is M24's own artefact and already on the calendar |
| **what happened last call** | the most recent saved call for this contact: its date, and the coach report's stored `nextAction` (or the summary's first action item) | record — written at the time, stored on the call, the rep has already seen it |

**Not records, and not for the line:** the prep brief's "Deal status" and
"Last time you spoke" sentences (`prep-brief.ts`) — model-generated for the
meeting. Richer, and already generated when a brief exists, but two sentences
of prose is a read, not a glance. They belong behind the line (hover or a
click to the brief), not on it. And nothing from the outcome gate, ever —
pinned by the same import-graph test that keeps outcome numbers off ungated
surfaces.

## The minimum useful version — one line, two glances

One quiet text run in the header row, left of the must-ask strip, present only
on a matched-meeting call:

> **Proposal · ⚠ high risk** · last call 27 Aug: "Send the pricing comparison"

- **Glance 1, any time mid-sentence:** stage and risk. Two words and a colour,
  fixed position, never changes during the call.
- **Glance 2, once at the start:** the last call's date and its next action, in
  quotes because it is the rep's own stored note. After the first minute it is
  ignored, which is fine — it has done its job.

Rules, all from the chip precedent: absent fields render nothing (no stage → no
line; no assessment → no risk; no prior call → no "last call"); the risk tier
comes from `resolveRisk`, not from reading the level directly; the last call is
the most recent **saved** call for that contact, never the one in progress; the
line never updates mid-call (a fact that changes while you talk is an
instrument, and 3c is about having fewer of those).

## Options

- **3d-1 (recommended) — the one line above, records only.** Cheapest,
  glanceable, gate-independent by construction.
- **3d-2 — the line plus the prep brief's two sentences on hover/expand.** Same
  line; the AI prose is one click away rather than on screen. Worth adding only
  if the founder finds themselves wanting the "why" mid-call. Nothing new is
  generated — it reads the brief that already exists for the meeting.
- **3d-3 — a deal panel.** Not proposed. 3a's lesson is that panels on this
  surface accrue, and a fourth floating stack narrows the transcript further.

**Cost of 3d-1:** small. Stage label and risk tier are already resolved for the
calendar; the last-call lookup is one `calls.list` filter by contact, done
once when the meeting matches. A structural test pinning that the module
imports nothing from `deal-outcomes`. No new data path, no AI call, no
mid-call refresh.

**Explicitly not proposed:** re-assessing risk during the call; generating a
prep brief mid-call; a "link this call to a deal" flow (out of scope); any
outcome-derived number.

**DECISIONS for the founder:** whether 3d ships at all; 3d-1 alone or with
3d-2's hover; and — the one taste call — whether "last call" earns its place on
the line or should live only behind it.

---

## Sequencing and the honest end

Both are small and independent. Recommendation: **3c-A first**, because it
addresses the clutter 3a exposed and the founder can only judge 3d's line on a
screen that is otherwise calm; then **3d-1** if deal context is missed
mid-call. Either can be dropped with no loss to the other; Stage 2 can end after
3c alone.

**Nothing here is built, and nothing here has been seen on a real call.** The
first thing to do after the founder's read is the read itself: one real call
with today's screen, noting what was looked at and when. That observation
outranks every table above.
