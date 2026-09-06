# M36 — the glance HUD on a real call: what to look for, what counts as failing, what it would change

**2026-09-06, evening. For the founder's own call.** The HUD has never been on a real call.
Everything below is written so the report can be observations (counts, times, what was on
screen) rather than impressions.

## Which app, and how to know it is the right one

- **The installed CallRise AI (v1.10.0) has no HUD.** The Live screen there is the old layout.
- The HUD is in the dev app started from `callrise-m34` (`npm run dev`, up since 17:47 today). That
  checkout is `d9d524d`, and `main` after tonight's merge is byte-identical to it (`git diff` empty),
  so the dev app IS what would ship.
- Tell them apart in two seconds: the HUD build shows a thin **state strip** under the header of the
  Live screen ("quiet / you / them", a talk-share bar, the deal line) and a **glance line** slot at the
  top. The old layout has the cue cards in the right rail and no strip.
- The HUD is on when the M31 design preview is on (Settings → Appearance; it is on unless it was
  turned off), and the layout is "glance" unless switched to "full" on the Live screen.

The sample call does not count: it renders a recorded transcript, so nothing about timing or roles
is being measured. It has to be a live call with the mic on and Deepgram transcribing.

## What is on the screen

1. **The glance line** (top, full width). One cue at a time, never more. Its left label is either
   **NOW** (deterministic: a pace warning, or a battlecard whose trigger phrase was heard) or
   **SUGGESTION** (a model's output). To its right, in small type, the evidence the cue was made
   from: `heard: "…"` (a transcript excerpt) or a measurement. Far right: `space = useful`, and an ×.
   A cue stays up at most 20 s. A cue that becomes ready while you are mid-sentence is held until
   you have been silent 1.5 s or the other party has spoken; if the hold outlasts the 20 s it is
   dropped without ever showing.
2. **The state strip.** Health, who is talking (**you / them / unsure who / quiet**, from the last
   transcript segment's role; "unsure" is shown on purpose, never smoothed into a guess), talk
   share as counted words (yours / theirs / unsure-not-counted; the bar turns amber above 65 %),
   and the deal line for the call's deal.
3. **The transcript**, below, on by default, collapsible.

Nothing else on the screen animates. If something else moves during the call, that is an
observation too.

## What to record (a count or a time for each, not a feeling)

Keep a clock visible. Write the wall-clock time next to anything odd; the app stamps every shown,
useful, expired and dismissed cue with a time, so a time in your notes can be matched to one row.

| # | Observation | Write down |
|---|---|---|
| 1 | Cues that appeared **while you were mid-sentence** | count, and the time of each |
| 2 | Cues whose `heard:` quote **was not said**, or was garbled | count; the quote as shown vs what was said |
| 3 | Cues with **no evidence text** beside them | count (should be impossible: no evidence, no line) |
| 4 | The **who-is-talking** dot wrong: "you" while the other party spoke, or "them" while you did | count of wrong readings you noticed, and how often it said "unsure who" |
| 5 | Cues that **vanished before you had read them** | count; roughly how long each was up |
| 6 | Cues shown per ten minutes | number, and the call length |
| 7 | Cues you **marked useful** (space, or a click on the line) | count; and whether your hands were on the keyboard at all |
| 8 | Cues you **dismissed** (×) and why | count and a word each |
| 9 | The deal line in the strip | correct for this deal, or what it showed instead |
| 10 | Talk share at the end | the % it showed, and whether it felt wrong by more than a little |
| 11 | Anything that pulled your eyes off the call other than the glance line | what and when |

After the call I read the app's own ledger (`callrise.hud.absorption` in the dev app's storage,
read-only) and the call's segment timestamps, so #1, #5, #6, #7 and #8 come back as measured
numbers to compare against your counts. There is no screen for that ledger yet; it is a
localStorage key, on purpose, until it has shown it measures something.

## What counts as failing

- **Any cue over your own sentence** (#1 > 0) fails the delivery rule. It is the rule the design
  rests on ("a cue over the rep's own sentence is worse than a late one").
- **A quote that was not said** (#2 > 0) fails the evidence rule. One is enough.
- **The dot wrong more than once or twice in a call**, or "unsure who" for most of it (#4), fails
  the state strip's honesty claim.
- **Cues gone before they could be read** (#5 > 0), or **fewer than one cue per ten minutes on a
  call with objections in it** (#6), means the delivery gate is starving the line.
- **Zero cues marked useful because your hands were never on the keyboard** (#7) is not a failure of
  the cues — it is a failure of the instrument, and the more important one.

## What I would change my mind about, per observation

- **#1 (cues over your sentence):** the lull gate reads the arrival time of transcript segments, not
  the audio. Deepgram's interim results lag your voice by a second or so, so "you stopped talking
  1.5 s ago" can be read while you are still talking. If #1 is not zero, the gate moves off the
  transcript and onto the microphone's own level (the app already measures it — the analyser
  behind the waveform), or the hold lengthens. Either way the mechanism changes, not the number.
- **#4 (the dot wrong, or unsure most of the time):** the role comes from diarization. If it is
  wrong on a real two-person call, the strip should not show a dot at all, and the talk-share bar
  is counting a guess and comes out with it. I would remove both rather than smooth them.
- **#2 (quotes not said):** the quote is a transcript excerpt, so a wrong quote is a transcript
  error the cue inherited. Deterministic cues (NOW) would then need the phrase match tightened;
  model cues (SUGGESTION) would need gating on transcript confidence, or dropping from the glance
  layout entirely, leaving NOW cues only.
- **#5/#6 (starved or vanishing):** the 20 s TTL and 1.5 s hold were chosen from the research, not
  from a call. Numbers here change the numbers there.
- **#7 (never marked useful, hands off the keyboard):** the absorption instrument as built assumes a
  rep at a keyboard. If you did not touch it once, the marking moves to after the call: a short
  "which of these helped" list at call end, next to the reason prompt. The live key would stay but
  would no longer be the instrument.
- **#9/#10/#11:** these decide whether the strip earns its place. If the deal line was wrong or the
  talk share was far off, the strip is showing a judgement dressed as a fact, and the offending
  item comes out.

If everything above comes back at zero and the cues were readable, the thing I learn is that the
delivery rule holds on one real call, which is the first evidence for the whole design — and the
next question becomes #6 and #7 on the founder's next five calls, not one.
