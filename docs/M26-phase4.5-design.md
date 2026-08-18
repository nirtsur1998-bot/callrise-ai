# M26 Phase 4.5 — Live Engine Decoupling: design proposal

> ⛔ **NOT BUILT — closed at 4.5.2, deliberately. Do not "finish" this.**
> *(Flagged by the M27 Phase 4 docs audit, 2026-08-14.)*
>
> **The architecture proposed below — moving cue/deal-intelligence engine state
> into main-process singletons, with new `dealIntelligence:attach` /
> `liveCue:attach` IPC handlers mirroring `transcription:attach` — was never
> built, and the founder's decision (recorded in `M26-release-checklist.md`) is
> that 4.5.3 onward WILL NOT be built.**
>
> What shipped instead was a smaller, lower-risk fix for the same bugs
> (BUG-055): `useLiveCues` and `useDealIntelligence` remain ordinary renderer
> hooks, hoisted into `LiveCallProvider.tsx` alongside the transcript so they
> sit above the navigation boundary, with reset scoped to a genuine new
> `callId` rather than to `active` blipping. Verified against current code —
> no `dealIntelligence:attach` or `liveCue:attach` handler exists anywhere in
> `src/main`.
>
> **Why this warning is more than an ordinary stale-doc note:** the analysis
> below is genuinely good — hundreds of lines of careful storm/replay/
> consent-gap failure-mode work — which makes it *more* likely, not less, that
> a future reader treats it as the current plan and either redoes abandoned
> work or reopens a decision that was closed on purpose. The failure-mode
> analysis is still worth reading; the proposed architecture is not the plan.

Status: **proposal, no code written.** Same method as Phase 4: read the actual source
(`useLiveCues.ts` 676 lines, `useDealIntelligence.ts` 492, `nudgeEngine.ts` 261, `engine.ts`,
`deal-tier1.ts` 260, `deal-tier2.ts` 228, `live-cue.ts` 502, `contextFusion.ts`, `consent-gate.ts`,
`loopback.ts`, `live-transcript.ts`, `transcription.ts`), then five parallel agents stress-tested
it against the founder's seven questions. Every claim below is a file:line citation I verified
directly against `claude/m26-engine-room` (`ecd3f3a` + the doc-record commit on top), not an
assumption carried over from the agents' reports.

---

## The one fact that reshapes this phase

**Phase 4 already solved the hard half of this problem, and solved it correctly — for the
transcript only.** `LiveCallProvider.tsx:70` hoists `useTranscription()` above the navigation
boundary, so `status` and `segments` already survive nav-away/nav-back. `useLiveCues` and
`useDealIntelligence`, though, are still called one level *below* that boundary, inside
`LiveView.tsx:292` and `LiveView.tsx:317`. They receive the now-correctly-anchored `active`
(`status === 'listening'`, `LiveView.tsx:293, 319`) and `segments`, but their own state — every
`useRef`/`useState` in both hooks — is still recreated from scratch on every `LiveView` remount,
because `useRef` initializers always re-run on first render of a new component instance.

This means the dedupe/cooldown *math* in both engines (`nudgeEngine.ts`'s `isDuplicate`/cooldown/
rolling-cap, `useLiveCues.ts`'s `emitInterrupt`) is safe by construction — neither file imports
React, both are pure functions of a state object and a clock argument. But the *container*
holding that state is component-instance-scoped, and there is a second, independent wipe
mechanism on top of the remount problem: both hooks run `if (!active || !enabled) reset()`
(`useDealIntelligence.ts:221`, `useLiveCues.ts:357-358`) — and `active` genuinely flips
`true → false → true` across every nav-away-and-back, even under the already-shipped 4.1-4.4
fix, because `status` passes through `'attaching'` on remount (`useTranscription.ts:106`) before
`reattach()` (`useTranscription.ts:307`) restores `'listening'`.

So the founder's framing is exactly right: this is not "port the math to main," which needs
nothing new — it's "give the math a home that outlives the view," which is genuinely the
hardest remaining step, because the codebase has two working precedents for it
(`live-transcript.ts`'s call-scoped singleton, `LiveCallProvider.tsx`'s provider-above-navigation
hoist) and this phase must apply the right parts of *both*, correctly, or reproduce the exact
storm/double-fire/silent-loss failure modes the founder is asking to be proven safe against.

---

## 1. What moves and what stays

### Rendering STAYS in the renderer, reading from main — same shape as the transcript

I read all six render call sites (`LiveView.tsx:807-1116`) and every component they mount.
None of them requires anything main lacks:

| Component | File | Local state | Callback props | Verdict |
|---|---|---|---|---|
| `CueCard` | `components/CueCard.tsx:93-136` | `shown` — a `requestAnimationFrame` mount-fade flag (`:100-104`) | `onDismiss` | Pure presentation. The 10s countdown bar (`:130-133`) is CSS `animationDuration` against a static constant, not a read of any live timer |
| `SuggestionRail` | `components/SuggestionRail.tsx:29-86` | none | `onDismiss` | Pure presentation |
| `CueControls` | `components/CueControls.tsx:17-49` | none | `onToggle`, `onSensitivity` | Pure controlled component |
| `EngagementGauge` | `components/EngagementGauge.tsx:19-74` | none | none | Same shape as `TranscriptView`'s value props |
| `MonologueMeter` | `components/MonologueMeter.tsx:33-51` | none | none | Same as above |
| `DealIntelligencePanel` | `deal-intelligence/ui/DealIntelligencePanel.tsx:125-202` | `ratedIds` (`:137`, explicitly documented as "purely a UI affordance"), plus `useArrivalFlash`/`useQuietGraceWindow`/`useTickingClock` | `onDismiss`, `onFeedback` | Pure presentation with local UI-timing sugar, all derived from `nudges`/`status` props already |

The six callback props (`dismiss`, `dismissSuggestion`, `onToggle`, `onSensitivity`,
`dismissDealIntelligenceNudge`, `rateDealIntelligenceNudge`) are today thin closures over local
`useState` (`useLiveCues.ts:343-345, 347-354`; `useDealIntelligence.ts:466-469, 471-480`). Once
the state they close over lives in main, each becomes a one-line IPC invoke — structurally
identical to `stop`/`togglePause`/`enableOtherParty`/`disableOtherParty`, which `LiveView.tsx`
already destructures from `liveCall` as IPC-backed callbacks today. `rateNudge`'s persistent half
is *already* an IPC round-trip (`window.api.dealIntelligence.recordFeedback`,
`useDealIntelligence.ts:477-479`) — only the in-call nudge list and health score are still
renderer-local; the persistence shape this phase needs already exists next to it in the same
file.

**The line, drawn deliberately:** rendering — including the 10s countdown, the arrival flash, the
quiet-grace window, the ticking clock — stays in the renderer, reading a snapshot/subscription
from main, the same way `TranscriptView` already renders from `useTranscription`'s mirrored copy
post-4.3. Nothing about *how a cue or nudge looks on screen* needs to know it moved.

### MUST move — sole copies of timing-dependent state, catastrophic if lost or reset wrong

**Cue engine** (`useLiveCues.ts`):
- `turnsRef` (80-turn cap, `:256, 619-637`) — subscribes to `onTranscript`/`onUtteranceEnd`
  **including interim partials** (`:576, 588-599, 651`); moving it is a `SHOULD`, not optional,
  because main *originates* these events (§5b below) and mirroring would be duplication, the
  same reasoning Phase 4 used for `otherPartyLive`.
- `cueRef` + `lastCueAtRef` + `dismissTimerRef` (`:253, 255, 273, 411-426`) — the interrupt
  channel's one-slot gate, cooldown clock, and 10s auto-release timer. **These three are one
  atomic state machine** (§2 below) and must move as a unit.
- `repSpeakerRef`/`epochRef`/`buyerNameRef` (`:258, 262, 267`) — already migrating under Phase 4
  as part of the transcript's role-resolution machinery; the cue engine reads the same identity.
- `lastCallAtRef`/`inFlightRef`/`debounceRef`/`generationRef` (`:270-272, 277`) — brain-call
  throttle, single-flight guard, debounce, staleness discard.
- `battlecardsRef`, `monologueRef`, `latencyRef` (`:246, 278-279`) — stateful helper instances,
  pure classes (`cue-latency.ts`, `monologue.ts` — zero `window`/`document`/`AudioContext`
  references by grep), move verbatim.

**Deal Intelligence** (`useDealIntelligence.ts`):
- `engineRef` (`LiveCallStateEngine`, `:127`) and `nudgeStateRef` (`NudgeEngineState { history,
  visibleNudges }`, `:128`) — the actual dedupe/cooldown/rolling-cap memory. `engine.ts` and
  `nudgeEngine.ts` are both pure reducers, zero renderer imports.
- `processedCountRef` (`:129`) — index into `segments` already folded into the engine. **This is
  the single most important ref in the whole phase** — see §3.
- `pendingTier1TurnsRef`/`pendingTier2TurnsRef` (cap 40/200, `:131-132`), both cooldown
  timestamps (`:135-136`), `generationRef` (`:137`), both in-flight guards (`:138-139`).
- `healthScoreRef`/`healthScoreHistoryRef` (cap 100, `:140, 142`) — Tier 2's own trajectory
  baseline; a fresh instance means the next health check reads as "no history," which is false.
- `dealContextRef` (`:141`) — see §4, this one's source is also moving.
- `feedbackAdjustmentsRef`/`nudgeFeedbackRef`/`finalizedReportRef` (`:143-144, 147`).

### STAYS — genuine per-process facts, not engine state

- `enabledTypesRef`/`sensitivityRef`/`agendaTopicsRef`/`meetingRef` (`useDealIntelligence.ts:
  149-165`) are prop mirrors, not accumulators — but the *settings they mirror* need a home in
  main too (§5c). Distinguish "this ref moves" from "the source of truth behind this ref needs
  to become main-readable" — they're different fixes landing in the same phase.
- Nothing in either engine touches `getUserMedia`/`AudioContext`/`getDisplayMedia` — I grepped
  both hooks and every pure-logic file (`engine.ts`, `nudgeEngine.ts`, `cue-latency.ts`,
  `monologue.ts`, `battlecards/match.ts`) for `performance.|Date.now|requestAnimationFrame|
  localStorage|window\.|document\.`; the only hits are doc comments and `contextFusion.ts`'s one
  IPC call (§4). **Unlike Phase 4, this phase has no hard OS-API boundary at all.** Everything
  that must move, can move cleanly. The difficulty is entirely in getting the *lifecycle* right
  (§2, §3), not in any capability main is missing.

---

## 2. The nudge engine's quality guarantees under decoupling

**The math needs zero changes. The wiring around it is what currently breaks the guarantee, and
would keep breaking it under a naive port.**

### What "naive" means here, concretely

If Phase 4.5 relocates `nudgeStateRef`/`cueRef`/`lastCueAtRef` into a main-process module but
keeps the *same trigger* for resetting them — `if (!active || !enabled) reset()`, now driven by
an IPC event or a main-side mirror of `status` — the wipe reappears on every navigation,
identically, just executed in main instead of in a doomed component. `active` is not a proxy for
"the call ended"; it is a proxy for "the LiveView screen happens to be mounted," and it flips on
every nav-away-and-back by design (`useTranscription.ts:106` → `'attaching'` → `reattach()` →
`'listening'`). A reset tied to it is a reset tied to navigation, not to the call.

### The three failure modes, checked against the actual mechanisms

**(a) Cue storm on return.** `isDuplicate` (`nudgeEngine.ts:178-185`) and `evaluateSignals`'s
cooldown check (`:236-239`) both key off `state.history` — an array of past nudges with
timestamps — compared against `nowMs`, an argument the caller supplies. If `history` survives the
nav gap, a signal that already surfaced at minute 4 is correctly suppressed by
`DEDUPE_WINDOW_MS = 5 * 60_000` (`:92`) when Tier 1 re-evaluates it at minute 5. If `history` is
reset (as it is today, and as it would be under a naive port), nothing blocks the re-fire — and
worse, per §3, a naive port doesn't just risk a re-fired *nudge*, it risks re-*ingesting the
entire call transcript* into a fresh engine, which re-derives the same Tier 0 signal and re-fires
Tier 1 against it. That compounds into exactly the storm the founder is asking to rule out.

**(b) Double-firing a cue shown right before nav-away.** Same mechanism, interrupt channel:
`emitInterrupt` (`useLiveCues.ts:411-426`) checks `if (cueRef.current) return false` (one slot)
and `if (now - lastCueAtRef.current < cfgRef.current.cooldownMs) return false` (cooldown,
`:414-415`) — 45s/30s/20s by sensitivity (`SENSITIVITY_THRESHOLDS`, `:64-67`). If `cueRef`/
`lastCueAtRef` survive the gap, a cue shown at t=100s correctly blocks a re-fire at t=105s after
nav-back. If they're reset, there's nothing to block it.

**(c) Safe by construction.** True for the reducer core (`nudgeEngine.ts` has no React import at
all; `useLiveCues.ts`'s checks are plain ref comparisons). **False for the system as wired
today** — the container is component-instance-scoped and there is a second, independent reset
path (`active`-gated) layered on top of the remount problem. Both must be fixed for the guarantee
to actually hold; fixing only the remount half (e.g. moving the refs into a main singleton but
leaving the `active`-triggered reset in place) leaves the guarantee broken in exactly the
scenario the founder named.

### The fix — no new suppression logic, new lifecycle wiring

1. Port `nudgeEngine.ts` and `useLiveCues.ts`'s `emitInterrupt`/`pushSuggestion` checks
   **unchanged**.
2. Instantiate the equivalent of `NudgeEngineState`/`cueRef`+`lastCueAtRef` **once per live
   call**, in main, keyed to the same session the transcript already uses
   (`live-transcript.ts:55`'s `current: LiveCall | null`, created by `beginCall()` at `:103`,
   destroyed by `endCall()` at `:264` — both called off the real Deepgram session lifecycle,
   never off a renderer attach/detach event).
3. Replace `if (!active || !enabled) reset()` (`useDealIntelligence.ts:221`, `useLiveCues.ts:
   357-358`) with a reset tied to genuine call end (hangup/save) or the feature being *disabled
   by the rep*, not to `status` transiting through `'attaching'`. This mirrors the fix
   Phase 4.4 already had to make for `savePendingRef`: "should this be reset?" is a decision that
   belongs to the session object, not to a boolean derived from whatever component happens to be
   mounted.
4. On `LiveView` remount, do a `reattach()`-style snapshot pull of current cue/nudge state
   (mirroring `useTranscription.ts:307`), never a fresh `createNudgeEngineState()`-style init.
5. `generationRef.current++` on every `!active` transition (`useDealIntelligence.ts:206`,
   `useLiveCues.ts:358, 384`) is the *same* bug in miniature: if the generation bump stays tied
   to `active`, a fully-computed nudge/cue that resolves during the nav gap gets discarded as
   stale on reattach — not a storm, a silent loss. It needs the identical fix: bump generation
   only on real session end, never on a view detaching.

**Proof obligation for this phase:** a test that (1) surfaces a nudge, (2) simulates detach, (3)
lets a signal that would re-trigger the same `type`+`subtype` arrive during the gap, (4) simulates
reattach, (5) asserts no second nudge appears and `history` contains exactly one entry with the
original timestamp. Mirror it for the interrupt channel with `cueRef`/`lastCueAtRef`. Both are
directly unit-testable once the state lives in main — currently trapped in a React hook, same
improvement Phase 4 got from moving the transcript.

---

## 3. Tier 1/Tier 2 in-flight work across detach

### Today: safe by accident, not by design

The AI call itself already runs entirely in main — `analyzeDealTier1`/`analyzeDealTier2`
(`deal-tier1.ts:197-251`, `deal-tier2.ts:155-219`) hold zero per-call state (only
`let registered = false` at `deal-tier1.ts:253`/`deal-tier2.ts:221`, a one-time IPC-registration
guard). A renderer unmount cannot abort work already running in main — there is no cancellation
channel to it, and the hook's own header says so (`useDealIntelligence.ts:16-24`): a stale
response is "discarded client-side via a generation counter instead of truly cancelled
server-side." The promise runs to completion regardless; only its *effect* — `setNudges`/
`setHealthScore`/`setStatus` — is gated by `if (myGeneration !== generationRef.current) return`
(`:266` Tier1, `:329` Tier2). React 19 (`package.json`) makes a state update on an unmounted
component a silent no-op, never a crash.

### The real hazard is not a same-tier race — it's instance duplication

`tier1InFlightRef`/`tier2InFlightRef` (`:231, 298`) make two concurrent same-tier passes
structurally impossible *within one hook instance*. That property survives migration as long as
main keeps exactly one engine instance per call. The actual risk is what happens when it doesn't:

`useDealIntelligence(...)` is called inside `LiveView.tsx:317`, **one level below**
`LiveCallProvider` (`LiveCallProvider.tsx:70`), where `useTranscription()` was hoisted in Phase
4.4. `status`/`segments` are correctly anchored to the real call (Phase 4's fix). But
`useDealIntelligence` itself is still reconstructed on every `LiveView` remount:

- **Nav-away**: the hook instance — `engineRef`, `nudgeStateRef`, `processedCountRef`, everything
  in `:127-147` — is abandoned. Any in-flight Tier1/Tier2 promise keeps running, harmlessly, per
  the mechanism above.
- **Nav-back**: `useDealIntelligence(segments, true, true, ...)` runs again, constructs a
  **brand-new** instance. `callStartWallClockRef.current` is `null` again, so the lazy-init block
  fires immediately (`:402-422`): `processedCountRef.current = 0`, fresh `engineRef`, fresh
  `nudgeStateRef`. But `segments` handed to this new instance is the **entire call transcript so
  far**, not just what happened after remount — `segments` is the array Phase 4 deliberately made
  survive nav (`useTranscription.ts:334`). The very next ingestion cycle does
  `segments.slice(processedCountRef.current)` = `segments.slice(0)` (`:427-428`) — **replaying
  every turn of the call from the start into a brand-new `LiveCallStateEngine`**, which re-emits
  any Tier 0 signal that already fired once (`:446`), immediately re-triggering
  `runTier1Pass('A Tier 0 signal fired')` (`:457`) against a `nudgeStateRef` with no memory of the
  earlier pass. This is a **deterministic replay artifact of instance reconstruction**, not a rare
  timing race — it reproduces on every nav-away-and-back mid-call, today, and would keep
  reproducing under a migration that relocates the refs but not the instantiation point.
- A second correctness bug, same root cause: Tier 2's trajectory baseline
  (`healthScoreRef.current?.score ?? null`, `:344`) is `null` on the fresh instance, so the first
  post-remount Tier 2 pass reports "no baseline" even though this is really the Nth health check
  of the call — a misleading flat read presented as if the call had no history.

### What happens to a response that lands while nobody's watching (the founder's actual question)

Once main owns the engine, the answer must be: **it writes into the call-scoped state anyway,
unconditionally** — the same shape `live-transcript.ts` already uses. `current: LiveCall | null`
(`:55`), created/destroyed by `beginCall()`/`endCall()` (`:103, 264`), called only off the real
transcription-session lifecycle (`transcription.ts:1109`, `transcription.ts:303`/`calls.ts:442`),
never off a renderer mount/unmount. `currentTranscript()`/`liveCallInfo()` (`:280-282, 287-300`)
let a freshly-reattached view read whatever's there. A Tier1/Tier2 response landing while no view
is attached is not a new problem this phase invents — it's the exact shape `live-transcript.ts`
already solved for transcript deltas arriving with nobody watching. Apply it a third time (after
the transcript and `LiveCallProvider`), don't solve it fresh.

### The guard this phase actually needs

1. **One main-owned singleton per live call**, holding everything currently in `:127-147`.
   Created/destroyed by the same real-session hooks `live-transcript.ts` uses — never by a
   renderer attach/detach IPC call.
2. **`LiveView` becomes a pure attach/subscribe client** for cue/deal state, the same shape
   `useTranscription` already is for the transcript: read a snapshot on attach, mirror pushes.
   `dismissNudge`/`rateNudge` become IPC calls that mutate the one main-owned state, not a local
   one.
3. **`processedCountRef`/`engineRef` must never be re-zeroed by a reattach** — only by a genuine
   new call. This alone eliminates the full-transcript-replay/duplicate-nudge hazard: once
   `LiveCallStateEngine.ingest()` only ever sees truly-new segments, once, the replay bug is
   structurally impossible regardless of how many times a view attaches/detaches.
4. **`generationRef`'s meaning narrows correctly for free** once its trigger is scoped to real
   call-end (§2 already requires this fix for the nudge engine — it's the identical fix, one
   mechanism, both engines).
5. If this phase introduces any place where two subsystems can independently decide "this call is
   over" (mirroring the render-process-gone-vs-save-in-flight race Phase 4.4 fixed at
   `live-transcript.ts:226-254`'s `saveInFlight` latch), replicate that guard rather than invent a
   new one.

**Bottom line:** the concurrency primitives already in `useDealIntelligence.ts` (single-flight
refs, cooldown timestamps, generation counter) are sound and need no redesign. The risk is
architectural — keeping engine *instantiation* coupled to `LiveView`'s mount lifecycle, the way it
still is today unlike `useTranscription`, would deterministically reproduce full-transcript
replay and duplicate-nudge bugs on every nav-away-then-back, exactly once main is expected to keep
running in the background. The fix is the pattern this codebase has already built and proven
twice — apply it a third time.

---

## 4. Prep brief's headless caller

`contextFusion.ts` is renderer code (`src/renderer/src/features/deal-intelligence/
contextFusion.ts`), called from `useDealIntelligence.ts:410` (`buildDealContext(meetingRef.
current)`), fed into both tiers' prompts via `dealContextRef` (`:141, 263, 326`). It calls
`window.api.prepBrief.getForEvent(...)` (`contextFusion.ts:39-45`) inside a `try` opened at `:38`.

**The bug, confirmed live on this branch today:** `const b = result.record.brief` (`:49`) assumes
`result` is a direct `PrepBriefResult`. `usePrepBrief.ts` (`:44-45`), the modal's caller, calls the
exact same `prepBrief:getForEvent`/`prepBrief:regenerate` channels
(`prep-brief-ipc.ts:103, 110`), which currently return that shape directly —
`ensurePrepBriefForEvent` (`prep-brief-ipc.ts:106, 113`) is not job-backed. So today this doesn't
throw. But it is one channel-shape change away from breaking silently: if a future job-migration
(mirroring Phase 3's pattern) changes this channel to `{ok, jobId}`, line 49 throws inside the
`try`, and the bare `catch` at `:62` swallows it into `EMPTY_CONTEXT` — no console output, no UI
signal, no unhandled rejection. `usePrepBrief.ts:37-66` is *less* defensive still (no try/catch at
all — a rejection there leaves the modal spinning forever), confirming the modal path was never
built to expect a job-backed response either. I checked whether any Phase 3 job migration has
touched this: `src/main/jobs/` has no prep-brief file, and grepping every
`getJobManager().registerType(...)` call site across `src/main` turns up zero prep-brief
registrations. The risk is real and specifically dangerous *because* it's silent, but it hasn't
fired yet.

**What "swallows every error" costs today, independent of the job-shape risk:** any
`getForEvent` failure — network, no AI key, malformed calendar match — degrades to
`meeting.notes ? notesOnlyContext(meeting.notes) : EMPTY_CONTEXT` (`:47, 61-65`) with zero
visibility. Tier 1 and Tier 2 keep running for the whole call with empty deal context while
nudges and the health meter render normally — ungrounded AI output presented with the same
confidence as grounded output. That's a worse failure than an outage, because nothing about the
UI changes to signal it.

### Migration, given this phase moves the caller into main anyway

This phase already needs to move `buildDealContext`'s caller (`useDealIntelligence.ts`) into
main. That is the natural point to fix this, not a separate task bolted on:

1. **Move `buildDealContext` into main**, calling `ensurePrepBriefForEvent`
   (`prep-brief-fs.ts:279`) **directly as a function call**, not through
   `window.api.prepBrief.getForEvent`'s IPC round-trip. Main already owns
   `ensurePrepBriefForEvent` — the IPC hop that `contextFusion.ts` currently pays for exists only
   because the caller used to be in the renderer. This is a simplification the migration gets for
   free, not extra scope: one fewer process boundary, and the `{ok, jobId}` risk disappears
   entirely for the live-call path because it's a same-process call to the function that already
   returns `PrepBriefResult` directly, not to the channel that IPC-facing code might reshape
   later.
2. **Make the failure visible, per the founder's requirement.** Replace the bare `catch` (`:62`)
   with one that: (a) still returns `EMPTY_CONTEXT`/notes-only so a Tier 1/2 pass never blocks on
   it — the founder didn't ask to change that degrade-gracefully behavior, correctly, since "no
   calendar match" is a normal case — but (b) logs the failure with enough context to find it
   (call id, meeting id, error), and (c) surfaces a `dealContextDegraded: boolean` flag alongside
   the context, threaded into main's Deal Intelligence session state and exposed to the renderer
   the same way `coachingPaused` already surfaces `pausedReason === 'all-models-unavailable'`
   (`live-cue.ts` result shape, `useLiveCues.ts:503`). The rep already has a precedent UI for
   "AI degraded, here's why" — reuse it rather than inventing a second indicator.
3. **Do not change `prep-brief-ipc.ts`'s response shape.** This phase has no reason to touch the
   modal's channel at all — that's tracked separately from Phase 4's own recommendation (leave
   the shared channel alone, add a job-backed one only for the modal if that's ever built). Moving
   the live-call caller off IPC entirely (step 1) makes this phase's own risk *independent* of
   whatever the modal channel does later, which is a stronger guarantee than coordinating around
   it.

---

## 5. Consent, restated

**Finding, confirmed by direct grep of the current files — zero matches for
`consent|recordOtherParty|Consent` in `live-cue.ts`, `deal-tier1.ts`, `deal-tier2.ts`,
`useLiveCues.ts`, `useDealIntelligence.ts`.** Neither engine has ever checked consent before
sending transcript content — including buyer-attributed content — to an AI provider. This is a
pre-existing gap on `claude/m26-engine-room` today, not something this phase introduces.

### Why the current renderer-coupling is not an accidental substitute for a real check

I traced what happens on a mid-call consent revoke to see whether today's coupling incidentally
provides protection a real check would. It doesn't, for the scenario that matters:

- Consent revoke reaches `LiveView.tsx:369-377` — the **only** continuously-reactive consent
  check in the live-call path: `const canRecordOther = consent.canRecord` → `useEffect` calling
  `window.api.consent.clear()` + `disableOtherParty()` when it flips false.
- `disableOtherParty` (`useTranscription.ts:741-761`) only detaches the loopback audio track and
  clears local UI warning state. It never touches `status`.
- `status` is what gates `active` for both engines (`LiveView.tsx:293, 319`). A consent revoke
  does not change `status`. **Revoking consent while staying on the LiveView screen does nothing
  to stop analysis** — `turnsRef`/`pendingTier1TurnsRef`/`pendingTier2TurnsRef` keep accumulating
  whatever segments arrive, including already-buffered buyer turns and any further ones from an
  already-open stream, and the debounced `liveCue` calls / 20s Tier1 interval / 150s Tier2
  interval keep firing exactly as before.
- The only thing today's coupling actually kills is a full `LiveView` unmount — i.e. navigating
  away — and that's documented as an accident, not a safety feature:
  `useTranscription.ts:904-906`'s own comment calls it "BUG-046: this cleanup also runs when the
  rep merely navigates to a different screen mid-call... not only on an actual Stop click." Nav
  and consent-revoke are orthogonal events in this codebase — revoking never navigates, navigating
  never revokes.

**So the honest framing is:** the gap is 100% pre-existing and exactly as bad today as it would be
post-migration. What this phase changes is the *exposure window*, not the presence of the bug.
Today, "however long `LiveView` stays mounted" is an accidental upper bound on how long stale
analysis can keep running after something changes. Once the engines are main-owned specifically
so they *survive* navigation — the explicit goal of this phase — that accidental cap disappears,
and a rep who revokes consent then navigates away (a plausible sequence: check something else
while the call continues) would today get analysis silently killed by the nav-away regardless of
consent; post-migration it keeps running indefinitely in the background, further from the rep's
mental model of "I left this screen."

### The fix, matching an existing pattern in this exact codebase

`src/main/consent-gate.ts:117` (`consentPermitsCapture(sessionId?)`) is the durable, disk-backed
gate — it reads `active-consent.json` fresh every call. It's already used, at exactly two call
sites, both in `src/main/loopback.ts` (`:123` arm, `:139` grant) — both one-shot checks at
stream-open, never re-checked once a stream is live. `src/main/memory/memory-hooks.ts:88-99`
(`runMemoryExtractionForCall`) is the established pattern for what this phase should do instead:
freeze **scope** at trigger time, re-read **permission** fresh on every invocation, with its own
comment stating this is deliberate — "the same way the M11 consent invariants are always re-read
rather than trusted from a snapshot."

**Requirement for this phase, restated per the founder's framing:** before any Tier1/Tier2/
`liveCue` pass includes buyer/`'other'`-role content in its prompt — `deal-tier1.ts`'s own
`evidenceRole: 'rep' | 'other'` type (`:66`) proves the engine already knows it's handling
buyer-attributed content — call `consentPermitsCapture(sessionId)` fresh, keyed to the call's
frozen session id, not trusted from a snapshot taken at call start or at engine-instantiation
time. If consent is not currently active, skip the buyer-attributed content for that pass (or
skip the pass if the content can't be cleanly separated — decide per-tier during implementation,
not in this document). This is one fix serving two purposes: it closes the pre-existing gap, and
it prevents this phase's own architecture change from silently widening the window that gap is
exposed through. Flag in the PR description that the underlying defect predates this phase and
should be tracked as its own fix even if this phase were paused — it is not conditional on the
migration happening.

---

## 6. Failure modes, plainly

For each: does the call survive, does the transcript survive, what does the rep see. This section
answers the founder's three named scenarios directly; §2/§3 already covered the
lifecycle-specific failure modes (storm, double-fire, replay) in depth.

### A. The engine throws mid-analysis

**Structurally contained today, and stays contained as long as one specific line is not crossed.**
`analyzeDealTier1`/`analyzeDealTier2` (`deal-tier1.ts:197-251`, `deal-tier2.ts:155-219`) and
`liveCue` (`live-cue.ts:361-486`) each wrap their entire body in one try/catch that never
rethrows — every path returns a typed `{ok:false, ...}`. Verified directly, not inferred.

The transcript's own fault-tolerance is unrelated and independent: `session`/`reportFault`/
`failSession` (`transcription.ts:192, 282, 349`) are module-private to `transcription.ts` — no
other file can reach them. `faultThresholdCrossed` (`:336-347`) trips `failSession` at 3 faults
in 5000ms (`FAULT_WINDOW_MS`/`FAULT_THRESHOLD`, `:319-320`), which ends the whole call, not a
subsystem. `live-transcript.ts`'s own entry points (`recordResult`, `:157-171`; `publish`,
`:78-93`) have their own swallowing catches and never call into `reportFault` either.

**The one way this phase could break that isolation:** if the turn-end trigger for the cue engine
(today `onTurnEnd`/`speechFinal`/`UtteranceEnd` in `useLiveCues.ts`) gets wired as a *synchronous
call inline* inside `transcription.ts`'s `ws.on('message')` handler (`:740-857`, where
`reportFault(s,'wsMessage',err)` fires at `:856`) rather than as an independently-scheduled poll
against main's own transcript getters. A throw from cue-engine logic inserted there is caught by
the *same* fault counter that guards the socket — three cue-engine bugs in 5 seconds would call
`failSession()` and end the entire live call, transcript included, over what should have been "no
cue this cycle." Given the cue engine's much larger surface (prompt building, schema validation,
buyer-identity logic) than transcript accumulation, this coupling would be a real regression from
today, where a `live-cue.ts` throw is isolated by its own IPC round-trip.

**Requirement:** give the moved engines their own timer/turn-watcher outside `transcription.ts`,
reading main's transcript via the getters already exported for exactly this kind of external,
read-only consumption (`currentTranscript()`, `liveCallInfo()`, `live-transcript.ts:280-300`) —
never an inline call inside the socket message handler's try block. This is the one architectural
line this phase must not cross, and it's avoidable by construction.

**With that line respected: call survives (unaffected), transcript survives (unaffected), rep
sees a quiet cycle — the next debounce/interval retries.**

### B. A Tier 1/Tier 2/cue model call hangs

**Bounded, not infinite, on two independent grounds.** `completeWithFallback` enforces a per-attempt
`AbortController` deadline. `coaching-cue` and `deal-tier1` have an explicit `CHAIN_BUDGET`
(`ai/types.ts:221-223`): 6000ms/2-chain and 4000ms/2-chain respectively. `deal-tier2` has no
`CHAIN_BUDGET` entry, so it falls back to `LATENCY_POLICY['deal-tier2'].timeoutMs = 60_000`
(`:184`) **per attempt**, with `maxRetries: 2` (`:184`) — worst case, a Tier 2 pass can take
materially longer than the other two before giving up. Separately: this is non-blocking network
I/O on Node's single-threaded event loop, so a pending AI call cannot stall `drain()`,
`healthTick()`, or the socket message handler — all independently-scheduled callbacks that keep
running regardless.

**Call survives, transcript survives, rep sees a quiet cycle for that engine** — bounded to
single-digit seconds for cue/Tier1, and worth surfacing explicitly in the UI for Tier2 (a
staleness indicator on the health score, e.g. "last updated Xs ago") since its worst case is long
enough that silence alone could read as broken rather than pending.

### C. The renderer crashes and reattaches mid-analysis

**The call and transcript are already handled — this is where the cue/deal engines currently have
no equivalent, and this phase has to build one, not preserve one.**

`render-process-gone` (`index.ts:273-276`) calls `handleRenderProcessGone()`
(`transcription.ts:1047-1050`) → `disposeTranscription()` + `endLiveCallUnsaved()` — deliberate,
by the function's own doc comment (`:1029-1044`): main has no "rep confirmed this is done" signal
on a crash, so it degrades to an unsaved, recoverable journal (`endCall({saved:false})`,
`live-transcript.ts:264, 270-271`) rather than guessing. This is unaffected by whether or how
this phase moves the cue/deal engines.

Two concrete gaps this phase must close, not risks to an existing invariant:

1. **No attach snapshot for cue/deal state.** `transcription:attach` (`transcription.ts:
   1235-1249`) returns a full snapshot so a reattaching renderer is immediately hydrated
   (`useTranscription.ts:309, 356`). There is no equivalent for nudges/health score/suggestions.
   Without a `dealIntelligence:attach`/`liveCue:attach`-shaped handler, a reattached `LiveView`
   shows a blank coaching panel until the next natural cycle (≤20s Tier1, ≤150s Tier2, next
   turn-end for cue) repopulates it. Bounded and non-destructive, but should ship in the same step
   as the state migration, not as a follow-up — an empty panel after a crash reads as broken.
2. **Stale-response-after-crash discard has no anchor once React is gone.** Today,
   `generationRef` (bumped on unmount/reset, checked at `useDealIntelligence.ts:266, 329`) is what
   discards a Tier1/Tier2 response that resolves after the component unmounted. Once this state
   lives in main, there's no React unmount to hang that check on — a Tier2 call in flight when a
   crash hits (bounded but up to ~60s+ per §6B) can resolve *after* `endCall({saved:false})` has
   already nulled `live-transcript.ts`'s `current` (`:266-267`). **Requirement:** the discard check
   must key off `liveCallInfo()?.callId`/`hasLiveCall()` (both already exported,
   `live-transcript.ts:287-304`) rather than a renderer lifecycle flag — otherwise a stale Tier2
   result from the crashed call could land as a nudge/health-score update against a *new* call the
   rep starts moments later. This is the same fresh-check-by-call-id pattern §5 already requires
   for consent — one requirement serving both, not two.

**Call survives (unsaved journal, recoverable — Phase 4's guarantee, unaffected). Transcript
survives (same). What the rep sees on reattach, once both gaps above are closed: whatever
nudge/health state existed at crash time, immediately, then live updates resume on the next
cycle — not a blank panel, not a stale nudge from a call that no longer exists.**

---

## 7. What I am NOT touching

Drawn explicitly, matching Phase 4's own practice, so it can't drift mid-phase:

- **The transcript pipeline itself** — `live-transcript.ts`, `transcription.ts`'s session/fault
  machinery, the journal/recovery mechanism, `LiveCallProvider.tsx`'s hoisting of
  `useTranscription`. All of Phase 4 stands as shipped; this phase builds on top of it, doesn't
  revisit it.
- **The reducer logic in `nudgeEngine.ts` and `engine.ts`** — dedupe window, cooldowns, rolling
  cap, Tier 0 extractors, priority ranking. Ports verbatim. Any change to the actual suppression
  *rules* (thresholds, windows, what counts as a duplicate) is a product decision, not a migration
  decision, and out of scope here.
- **`deal-tier1.ts`/`deal-tier2.ts`/`live-cue.ts`'s own request/response bodies** — prompt
  construction, tool schemas, sanitization. Already stateless, already in main, unchanged by this
  phase except for the consent gate (§5) added at the top of each.
- **`completeWithFallback` and the AI provider chain/budget/retry policy** — `CHAIN_BUDGET`,
  `LATENCY_POLICY`, fallback ordering. M9/M24-hardened, orthogonal to where the *caller* of these
  functions lives.
- **The Radar Report's content and `DealIntelligenceRecord` shape** (`calls-fs.ts:327`) — only
  *when* it gets assembled changes (from main's own state instead of a renderer callback), not
  what's in it.
- **`prep-brief-ipc.ts`'s shared channel shape**, per §4 — the modal caller is untouched; this
  phase's fix is isolated to the live-call caller moving off IPC entirely.
- **Consent capture/recording itself (M11)** — `consent-gate.ts`, `ConsentModal.tsx`, `useConsent
  .ts`'s revoke UI. This phase adds a *read* of the existing gate at the analysis boundary; it
  does not change how consent is captured, stored, or revoked.
- **Settings UI** — moving Deal Intelligence's enabled/sensitivity/frequency settings to a
  main-readable store (§1, `useDealIntelligenceSettings.ts:6-9`'s premise no longer holding) is a
  storage-location change, not a UX change. The Settings screen keeps its current controls.
- **The simulator** (`simulator/callSimulator.ts`) — feeds `engine.ts` directly today and can keep
  doing so against the migrated version; not part of this phase's surface.

---

## Phased plan within Phase 4.5

Each step ships independently and leaves the app working, matching Phase 4's own discipline.

**4.5.0 — Multi-subscriber transcript listener.** `live-transcript.ts:59`'s
`listener: ((patch: TranscriptPatch) => void) | null` is single-slot, currently wired to the
renderer relay. Both engines need their own in-process tap into the same `publish()` stream.
Small, contained, mechanical — becomes an array of listeners (or a second registration function),
prerequisite for everything after it. *Verifiable: existing renderer relay behavior unchanged.*

**4.5.1 — Cue engine's fast tier needs interim transcripts.** `useLiveCues.ts:588-599`'s
battlecard matching runs against non-final partials, but `live-transcript.ts:164`'s
`recordResult` deliberately drops interims before writing (`:161-163`'s own comment). The cue
engine cannot subscribe to the accumulator the way Deal Intelligence can — it needs its own tap
directly into `transcription.ts`'s message handler output, **read via an independently-scheduled
poll against exported getters, never an inline call inside `ws.on('message')`'s try block** (§6A's
hard boundary). *Verifiable: cue engine sees the same interim stream it does today, byte-for-byte.*

**4.5.2 — Settings become main-readable.** Deal Intelligence's `enabled`/`sensitivity`/
`enabledTypes`/`frequency` and the cue engine's `enabled`/`sensitivity` move to a main-side store,
same shape `loadAppSettings()`/`isSelfIntroExtractionAllowed()` already use. Renderer keeps its
current Settings UI, now reading/writing through IPC instead of `localStorage` directly.
*Verifiable: toggling a setting still changes engine behavior identically.*

**4.5.3 — Deal Intelligence state moves to a main-owned, call-scoped singleton.** `engineRef`,
`nudgeStateRef`, `processedCountRef`, both pending-turn queues, both cooldown timestamps,
`generationRef`, both in-flight guards, `healthScoreRef`/`healthScoreHistoryRef`,
`feedbackAdjustmentsRef`, `nudgeFeedbackRef`, `finalizedReportRef` — created/destroyed by the
same real-session hooks `live-transcript.ts` uses (§3), never by renderer attach/detach.
`contextFusion.ts`'s `buildDealContext` moves with it, calling `ensurePrepBriefForEvent` directly
(§4). Consent check (§5) added at the top of each Tier1/Tier2 pass before buyer-attributed
content is included. This is the largest single step and the one everything else depends on.
*Verifiable: nudge/health-score output identical to today for the same transcript, on a call that
never navigates away — the control case that proves the migration didn't change behavior, only
ownership.*

**4.5.4 — Cue engine state moves to the same singleton.** `cueRef`+`lastCueAtRef`+
`dismissTimerRef` as one atomic unit (§2), `turnsRef`, the brain-call throttle/debounce/
single-flight refs, `battlecardsRef`/`monologueRef`/`latencyRef`. *Verifiable: same control case
as 4.5.3 — identical cue timing on a call that never navigates.*

**4.5.5 — Attach/detach for cue and deal state.** `dealIntelligence:attach`/`liveCue:attach`-shaped
handlers returning current nudges/health score/suggestions/cue on `LiveView` mount, mirroring
`transcription:attach`. `LiveView` stops instantiating `useLiveCues`/`useDealIntelligence` as
stateful hooks and becomes a subscribe/mirror client, the same shape `useTranscription` already
is. `dismissNudge`/`rateNudge`/`dismiss`/`dismissSuggestion` become IPC calls. Reset triggers
(§2) move from `active`-gated to genuine-call-end-gated in this same step — the attach/detach
plumbing and the reset-scope fix are inseparable; shipping one without the other reintroduces the
storm risk.

**4.5.6 — Crash/reattach discard fix.** Key the stale-response discard off `liveCallInfo()?.
callId`/`hasLiveCall()` instead of `generationRef` alone (§6C). Small, isolated, but must land
before this phase is called done — it's the one gap with no natural forcing function to catch it
in testing (it only shows up on a crash during an in-flight Tier2 call).

**4.5.7 — Radar Report assembly moves to main.** `getDealIntelligenceReport()` reads main's own
state instead of a renderer callback closing over local refs. Mechanical once 4.5.3-4.5.5 are
done — the record shape (`DealIntelligenceRecord`, `calls-fs.ts:327`) doesn't change.

---

## Testing, and what only you can verify

**Automated (me):** `nudgeEngine.ts`/cue-engine cooldown math directly unit-testable once moved
(currently trapped in React hooks, same improvement Phase 4 got for the transcript). The proof
obligation from §2 (detach → concurrent duplicate signal → reattach → no re-fire, exact history).
The replay-prevention proof from §3 (`processedCountRef` never re-zeros on reattach, only on real
call-end). Consent-gate-at-analysis-boundary tests (buyer content excluded when
`consentPermitsCapture` returns false, mid-call, without navigating). Crash-then-late-Tier2-
response-lands-against-new-call, asserting it's discarded. Prep-brief failure visibility
(`dealContextDegraded` flag set and logged on a forced `ensurePrepBriefForEvent` failure).

**Only you, on a real call — the simulator cannot prove any of these:**

1. **Navigate away mid-call and back, several times**, while a nudge is visible and while one is
   on cooldown. No storm, no double-fire, no early-return-of-a-suppressed-cue. This is the
   founder's own headline test for this phase.
2. **Navigate away right as a Tier 2 pass is in flight**, then back before it resolves. Health
   score updates once, correctly, not twice, not with a "no baseline" flash.
3. **Revoke buyer consent mid-call without navigating**, then say something buyer-attributed.
   Confirm no further buyer content reaches a Tier1/Tier2/cue prompt (this needs your own log
   inspection or a debug flag — not visible from the UI alone, since the fix is a silent skip, not
   a UI change).
4. **Force-quit or crash the renderer while a Tier2 pass is in flight**, relaunch, start a new
   call. Confirm the new call's health score is not contaminated by the old call's late response.
5. **A genuinely long call (20+ min) with Deal Intelligence and cues both on**, watching for
   nudge-history growth, cooldown drift, or any suppression rule behaving differently at minute 25
   than it did at minute 2 — the kind of slow drift a short automated test can't surface.
6. **Prep brief failing outright** (kill network, or point at a bad calendar match) — confirm the
   rep-visible degradation signal (§4) actually appears and reads as "AI degraded, here's why,"
   not as a silent quality drop in the nudges themselves.
