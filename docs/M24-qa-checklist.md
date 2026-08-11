# M24 Live Deal Intelligence — manual QA checklist

Run the Call Simulator pass first (fast, deterministic, no AI keys required
for the Tier 0 parts) to sanity-check the engine/UI wiring, then do at least
one real live call with a connected AI provider to verify the AI-dependent
layers end to end. Check off each item; anything that fails goes back to the
engineer with the exact repro (which simulator scenario / what was said /
what was expected vs. seen).

## 0. Setup

- [ ] `npm run build` succeeds with zero errors.
- [ ] Launch the built app (`npm run start` or the installed build) and
      confirm it opens to the login screen with no console errors, no white
      screen, no crash.
- [ ] Settings → Live Deal Intelligence (Beta) is visible and OFF by default
      on a fresh profile.

## 1. Call Simulator pass (Tier 0 + engine wiring)

Run `npm run simulate:call -- <scenario>` for each of `healthy`, `stalling`,
`authority` (see `simulator/transcripts/`).

- [ ] Each scenario runs to completion with no thrown errors.
- [ ] `healthy`: call stage progresses through the expected stages; no
      spurious risk signals fire on ordinary back-and-forth.
- [ ] `stalling`: monologue / silence-gap / question-drought signals fire at
      roughly the points the transcript was designed to trigger them.
- [ ] `authority`: authority-gap mentions are detected; call stage does NOT
      prematurely flip to "closing" on words like "approve"/"sign off" (this
      was a real bug found and fixed during development — regression-check
      it specifically).

## 2. Settings

- [ ] Master toggle on/off actually gates everything below — with it off, no
      Tier 1/2 IPC calls fire during a live call (check the main process log
      for `[deal-tier1]`/`[deal-tier2]` — there should be none).
- [ ] Sensitivity (Quiet / Balanced / Aggressive) changes visibly change how
      often nudges appear over a long call — Aggressive should show
      meaningfully more than Quiet on the same transcript.
- [ ] Nudge type toggles: turning off "Risk" during a live call means no risk
      nudges appear, even when a risk-shaped moment happens; opportunity and
      tactical still work normally. Confirm the UI physically prevents
      turning off all three at once.
- [ ] Analysis frequency (Frequent / Balanced / Infrequent): changing it
      mid-call visibly changes how soon the next check-in happens (Frequent
      ≈ 10s, Balanced ≈ 20s, Infrequent ≈ 40s for Tier 1).

## 3. Live call — Tier 1 nudges

Start a real call (with a real or a second-device counterpart) with the
feature ON and a working AI provider key configured.

- [ ] A nudge appears within a reasonable time of a genuinely notable moment
      (e.g. deliberately raise a price objection, then go quiet about it).
- [ ] The nudge shows: type (risk/opportunity/tactical) with correct icon
      and color, a specific suggested action (not generic boilerplate), and
      the exact evidence quote — verify the quote is a real, verbatim
      excerpt from what was actually said, not a paraphrase or invention.
- [ ] Evidence quote correctly attributes "You said" vs. "They said."
      Thumbs up / thumbs down on a nudge registers (no error), and the
      button state updates to show it was rated.
- [ ] Over a longer stretch of ordinary conversation, nudges stay rare — this
      should not feel like a notification flood.
- [ ] If your Knowledge Base has objection-handling entries, deliberately
      trigger a matching objection and confirm the suggested cue references
      your own material rather than generic advice.

## 4. Live call — Tier 2 health score

- [ ] The health score panel appears within a few minutes of call start (or
      immediately if the call stage changes, e.g. moves from open to
      pricing).
- [ ] Score is 0–100, trajectory arrow (up/flat/down) matches the direction
      the score actually moved since the last read.
- [ ] "Top move" recommendation is specific to what's actually happened on
      the call, not generic sales advice.
- [ ] Expanding the factor breakdown shows all five factors
      (engagement/sentiment/objections/momentum/agenda), each 0–100 with a
      sensible-looking bar.

## 5. Context fusion

- [ ] For a call linked to a calendar event with a prep brief, confirm a
      nudge or the health score's recommendation actually reflects that
      context (e.g. references the prospect's stated priorities) at least
      once during the call.
- [ ] For a call with NO linked meeting/prep brief, confirm the feature still
      works normally (no errors, nudges/score still appear) — absence of
      context must degrade gracefully, not break anything.

## 6. Consent boundary (critical — do not skip)

- [ ] On a call where the other party has NOT consented to being recorded,
      confirm no nudge is ever generated from anything the other party said
      — the transcript delta fed to Tier 1/2 must exclude their audio
      entirely, same as every other AI feature in the app already enforces.
- [ ] Confirm this holds even when the rep says something that would
      normally trigger a nudge (e.g. mentions a price) — the feature should
      still work off the rep's own side of the conversation.

## 7. Post-call — Radar Report

- [ ] After ending a call that had nudges/health history, open it from Past
      Calls and confirm the Radar Report section appears near the bottom.
- [ ] The type-count badges (e.g. "2 Risks", "1 Opportunity") match what
      actually appeared live.
- [ ] The "rated helpful" badge math is correct against what you actually
      thumbs-up/down'd during the call.
- [ ] The health score curve renders, left-to-right in time order, with the
      first/last score labels matching the actual first and last reads.
- [ ] Every nudge in the timeline lists in the correct time order (mm:ss from
      call start) and its evidence quote expands/collapses correctly.
- [ ] A nudge you rated live shows the correct thumbs-up/down indicator in
      the report.
- [ ] A call where the feature was OFF the whole time shows NO Radar Report
      section at all (not an empty one).

## 8. Regression check — existing features untouched

- [ ] Live coaching cues (M9) still work normally alongside Deal
      Intelligence, with no visual overlap or interference between the two
      panels.
- [ ] Turning Deal Intelligence off entirely leaves every other live-call
      feature (transcription, cues, bookmarks, consent banner) behaving
      exactly as before this milestone.
- [ ] `npx vitest run` — full suite green.
- [ ] `npm run typecheck` — zero errors.

## 9. Cross-platform

- [ ] **macOS**: not run in this environment (no Mac available). Needs a
      pass through sections 1–8 above on a real Mac build before this is
      considered fully verified cross-platform. Nothing in the design is
      Windows-specific, but this is a real gap, not an assumption to wave
      away.
