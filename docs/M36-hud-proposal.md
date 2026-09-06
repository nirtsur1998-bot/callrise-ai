# M36 Stage 2 — the live call HUD, properly: a proposal

**2026-09-06, overnight. A point of view to argue with, not a menu.** Built: nothing yet, on
purpose — see "Why this is not built tonight" at the end.

## The thesis in one sentence

**The HUD is a single line, not a dashboard.** A person mid-conversation can absorb one short,
verb-first sentence every half minute or so, in peripheral vision, without leaving the buyer; every
other pixel is either decoration or harm, and the honest version of this screen is the one that
shows less and says where each thing came from.

## What the research says (and what it does not)

- **Agent-assist products converged on the same lesson the hard way.** The 2026 round-ups describe
  the surviving pattern as an "AI whisper coach: one useful next question or cue, not a wall of
  scripts that pulls attention off the buyer", private and glanceable, stage-aware, and — the one
  hard number in the genre — sub-second latency between the buyer's words and the cue, because a
  late cue is an interruption ([Balto 2026 round-up](https://www.balto.ai/blog/best-ai-tools-for-real-time-agent-assist-on-sales-calls-2026/),
  [AssemblyAI's platform survey](https://www.assemblyai.com/blog/best-agent-assist-software),
  [JustCall on real-time assist](https://justcall.io/blog/ai-real-time-sales-assist.html)).
- **Cockpits learned it first.** The head-up display literature names the failure exactly:
  *attention capture* — compelling symbology in the near field that stops the pilot seeing the far
  field — and answers it with scan discipline and a hard cap on density: "the appropriate amount of
  information to make effective decisions and not become cognitively overloaded"
  ([Head-Up Displays and Attention Capture](https://www.researchgate.net/publication/24297897_Head-Up_Displays_and_Attention_Capture),
  [HUD design guide](https://www.researchgate.net/publication/235122557_Improvement_of_Head-Up_Display_Standards_Volume_1_Head-Up_Display_Design_Guide_Appendix),
  [ScienceDirect overview](https://www.sciencedirect.com/topics/engineering/head-up-display)).
  The rep's far field is the buyer's face and voice. Anything on our screen that competes with it
  is attention capture by another name.
- **What the research does NOT say.** The one 2026 academic paper the search surfaced,
  *Enterprise Sales Copilot* ([arXiv 2603.21416](https://arxiv.org/abs/2603.21416)), is a speed
  paper — 2.8 s mean answer time, 100% question detection — and says nothing about what a human
  absorbs, when, or how over-prompting erodes trust. Nobody has published the absorption number.
  So the pacing below is an argument from the cockpit and the market, not a measurement, and the
  measurement plan at the end exists to replace it with ours.

## What we have today, read from the code, not from memory

`features/live/`: six cue kinds (`pace`, `battlecard`, `objection`, `discovery`, `next-question`,
`buying-signal`), a **strict one-cue slot with a hard cooldown** of 45 / 30 / 20 s by sensitivity
(`useLiveCues.ts` — already the right instinct), deterministic battlecard triggers (keyword match,
"deterministic is necessary but not sufficient"), an **engagement gauge** that needs four turns and
labels itself "approximate", a **monologue meter**, a **must-ask strip**, a **deal facts line**, a
**suggestion rail**, an **ask-the-coach box**, a waveform, a quiet toggle, and the thin-transcript
guard that fired correctly on the Stage 2 VM. The transcript is the biggest thing on the screen.
Speaker attribution carries an `UNSURE` label that the walk showed on screen.

That is nine surfaces competing for a glance. 3c/3d/3e shipped into this and were never observed on
a real call; the founder's own observation of Quiet, the deal line and the reason prompt is still
owed and outranks this document.

## The proposal: the glance line

**Three zones, and only three.**

1. **The glance line.** One cue at a time, at most twelve words, verb first, and *always* with its
   evidence beside it in smaller type: `heard: "that's more than we budgeted"` for a triggered cue,
   `you: 71% of the last 2 min` for a measured one. It expires after ~20 s and is never replaced
   sooner than the existing cooldown. It sits where peripheral vision finds it — top of the window,
   full width, high contrast — and nothing else on the screen animates.
2. **The state strip.** Three facts that are true by construction and never judgements:
   *listening / paused / reconnecting* (already honest), *who is talking: you / them / unsure*
   (the `UNSURE` stays visible — it is the honesty), and *talk share* as a plain bar of measured
   seconds. When transcription is behind, the strip says **"catching up, 8 s behind"** in place of
   any cue, because a cue about a moment that has passed is a false claim about now.
3. **The transcript, demoted.** Smaller, behind, scrolling, off by default in the glance layout.
   The rep's job is to look at the buyer; the transcript is for after.

**What leaves the live screen** (moves to pre-call or post-call, where a person can read):
the engagement gauge (a judgement dressed as a number, needing four turns, self-described as
approximate — it cannot be acted on mid-sentence and it is exactly the compelling symbology the
cockpit literature warns about), the suggestion rail (a list during a call is a wall of scripts),
the deal facts line (pre-call brief material), and ask-the-coach as a rail (it stays reachable
by one key, hidden until asked).

**What stays and gets sharper:** the one-slot cooldown; the must-ask strip becomes the
`next-question` *source* for the glance line, surfaced only in a lull; the monologue meter becomes
the talk-share bar in the strip; the quiet toggle becomes the switch between *glance* (default)
and *full* (today's screen, for people who want it).

**Pacing, the one new mechanism:** *lull-gated delivery*. A cue that is ready while the rep is
speaking waits for the rep's silence window (buyer's turn ended, or ~1.5 s of rep silence) before it
shows; a cue that would fire over the rep's own sentence is worse than a late one. Cues that expire
unseen are recorded, not shown later.

## The constraint that does not move: never claim what it does not know

Made mechanical, not remembered:

- **No cue without evidence.** The cue type carries a required `evidence` field (`heard` quote with
  the transcript offset, or `measured` value with its window). A cue constructed without one does
  not render; a test pins it.
- **Two vocabularies, never mixed.** Deterministic cues say *heard:*; model-generated suggestions
  say *suggestion:* and never appear on the glance line while the transcript is behind.
- **Unsure stays unsure.** Speaker `UNSURE` is rendered, not smoothed; the talk-share bar excludes
  unsure seconds and says so on hover.
- **Lag is a state, not a cue.** Above a threshold the line shows the lag and nothing else.
- **Nothing on the live screen predicts.** Engagement, deal risk, "buying temperature" — anything
  that is an inference about the buyer's mind — is post-call, where it can carry its reasoning.

## How it would be measured (before it ships)

1. **Absorption:** one key (space, or a click on the line) marks a cue *useful*; the rate of marked
   cues per shown cue, per kind, per sensitivity. This is the number nobody has published.
2. **Latency:** trigger-to-render, logged per cue; the sub-second bar from the market is the target.
3. **Load:** cues shown per ten minutes; expired-unseen per ten minutes.
4. **The founder's real calls:** the observation that is already owed — Quiet, the deal line, the
   reason prompt — extended to the glance line. It outranks all three numbers above.

## Why this is not built tonight, and what it is

It is renderer-only and would sit behind the existing preview mechanism, so a first cut is a
day's work, not a milestone's. But it is the screen the founder stares at during the
highest-pressure minutes of the day, the founder asked for a point of view to argue with, and
building the wrong opinion overnight would cost a day plus the argument. **Stage 2 is one proposal
and one decision away from being buildable in the same session; it is not a milestone of its own
unless the founder wants the full-layout parity and the measurement instrumentation shipped
together, in which case it is.** The morning's ask is a reaction, then the build.
