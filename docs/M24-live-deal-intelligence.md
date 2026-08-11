# Live Deal Intelligence (Beta)

*A plain-language explanation of what this feature does, how it works, and
what it does and doesn't do. Written for a founder, not an engineer — the
technical implementation lives in code comments and this doc stays high-level
on purpose.*

## What it is

While you're on a live sales call, CallRise AI now watches the conversation
in the background and — rarely, only when it actually matters — taps you on
the shoulder with something worth knowing right now: the deal is stalling,
the buyer just gave you an opening, or there's something specific you should
say or do in the next few seconds. Alongside that, it keeps a running "deal
health score" (0–100) that updates every couple of minutes, so you have a
sense of how the call is actually going, not just a feeling.

After the call, everything it caught is saved to that call's page as a
**Radar Report** — a timeline of every moment it flagged, with the exact
quote it was based on, plus the health score curve for the whole call. You
can thumbs-up or thumbs-down each one; the app learns from that over time and
gets pickier about what it shows you.

This is **off by default**. It's a Beta feature you turn on per your own
comfort level, in Settings → Live Deal Intelligence.

## Why "rare and high-value," not "chatty"

The single biggest risk with a feature like this is that it turns into
background noise the rep learns to tune out — a flood of low-value pop-ups
that ends up making the call experience *worse*, not better. Every part of
this was built around avoiding that:

- It is instructed to stay quiet unless something is genuinely notable —
  most short stretches of a normal conversation should produce nothing.
- Even when it does find something, a whole set of independent checks (how
  confident it is, whether something similar was just shown, whether you
  already addressed it, how many nudges you've already seen recently) has to
  pass before it actually appears on screen.
- You control how aggressive it is (Quiet / Balanced / Aggressive), which
  *types* of moments it's even allowed to show you (risk / opportunity /
  tactical — you can turn any of these off individually), and how often it
  re-checks the call (Frequent / Balanced / Infrequent).
- Every single thing it shows you comes with the exact transcript quote it's
  based on, right there, one click away at most — never just "trust us."

## How it actually works (high level)

Under the hood this runs in three layers, from cheapest/fastest to
most-expensive/slowest:

1. **Instant, free checks** — running totals like how much you're talking vs.
   the buyer, how long since anyone asked a question, whether pricing or a
   timeline got mentioned. No AI calls involved, essentially free, updates
   continuously.
2. **Fast AI check-ins** — every ~20 seconds, or immediately when one of the
   instant checks above notices something (like a long silence), a fast AI
   pass looks at just the last bit of conversation and decides whether
   there's a real risk, opportunity, or tactical moment worth surfacing.
3. **Strategic AI review** — every 2–3 minutes, or whenever the call
   noticeably shifts phase (e.g. moves from discovery into pricing), a
   slower, more thorough AI pass reads more of the call and produces the
   0–100 health score plus one specific strategic recommendation.

Both AI layers are also told about the deal's own context when it's
available (the prep brief, the last call with this prospect, your own
objection-handling playbook from the Knowledge Base) so a nudge can say
something as specific as *"same price pushback as last time — here's your
own answer to it"* instead of generic advice.

## What it will never do

- **It never listens to or analyzes the other person on the call unless you
  already have their consent to record them**, per the app's existing
  consent rules. If consent isn't in place, this feature simply doesn't get
  that audio to work with — same protection that already applies everywhere
  else in the app.
- It never touches how your microphone or audio actually works — this is
  pure analysis of the transcript that's already being generated, nothing
  about audio capture changes.
- It never sends anything anywhere new — it reuses the same transcription
  (Deepgram) and the same AI provider setup (your own API keys) the rest of
  the app already uses. No new third-party services, no new data leaving the
  app that wasn't already leaving it for other features.
- It never interrupts you with more than a small number of things per
  call — there's a hard cap on how often it can show something, regardless
  of settings.

## What it costs

Every fast check-in and strategic review is a real AI API call, billed
through your own connected provider account (same as coaching, cue
suggestions, etc. elsewhere in the app). A typical call will make roughly:
a handful of fast check-ins (every ~20s while something's actually being
said) and 1–3 strategic reviews (every 2–3 min). Setting the analysis
frequency to "Infrequent" roughly halves this; "Frequent" roughly doubles it.

## Where to find it

- **Turn it on**: Settings → Live Deal Intelligence (Beta) → the master
  toggle at the top.
- **Tune it**: same page — sensitivity, which nudge types to show, and how
  often it checks in.
- **During a call**: a small panel appears alongside the existing live
  coaching cues, showing nudges as they arrive and the health score once the
  first strategic review has run (a few minutes in).
- **After a call**: open that call from Past Calls → the **Radar Report**
  section near the bottom of the page.

## Known limitations

- **Not yet verified on macOS.** This was built and tested entirely on
  Windows in this environment (no macOS machine available here). Nothing
  about the design is Windows-specific — it's all transcript/AI-layer logic
  reusing existing cross-platform infrastructure — but "should work" is not
  the same as "confirmed working," and it should get a real run-through on a
  Mac before being considered fully verified there.
- **The health score is a read on how the call is going, not a prediction of
  whether the deal will close.** It's explicitly scoped that way in what the
  AI is asked to produce.
- Like the rest of the app's AI-powered features, quality depends on the
  quality of the connected AI provider/model — a weaker or slower model will
  produce weaker or slower nudges.
