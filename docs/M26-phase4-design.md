# M26 Phase 4 — Live Call Decoupling: design proposal

Status: **proposal, no code written.** Researched by 10 parallel agents reading the
actual source (`useTranscription.ts` 863 lines, `useLiveCues.ts` 676,
`useDealIntelligence.ts` 492, `LiveView.tsx` 1095, `main/transcription.ts` 1065,
plus the audio, clips and consent hooks), then five failure scenarios stress-tested
against that code. Every claim below is a file:line citation, not an assumption.

---

## The one fact that reshapes everything

**The main process holds no transcript at all.**

`interface Session` (`main/transcription.ts:90-163`) has fields for the socket, the
speaker epoch, the producer guard, and the lag/health/drift/liveness trackers — and
no text storage of any kind. Main receives each Deepgram result, emits it to the
renderer (`main/transcription.ts:663-673`), and forgets it. `transcript`/`words` are
function-local consts.

So the entire transcript of a live call exists in exactly one place: `segmentsRef`,
a React ref (`useTranscription.ts:148`) inside a component that unmounts on every
navigation (`MainApp.tsx:333-343`). It is written to disk exactly once, at the end
of the call (`useTranscription.ts:218-229`).

This inverts the usual framing. "Main owns the session" is true of the *socket* and
false of the *call*. Main is a relay. That single fact is what makes Phase 4 a real
migration rather than a refactor — and it is also why every failure scenario below
ends in total loss.

**The good news**, which makes this smaller than it looks: audio already flows
renderer→main as raw PCM (`useTranscription.ts:510`), and main already owns the
socket, the speaker epoch and all health tracking. The renderer is *already*
essentially a capture device. Transcript accumulation is the sole anomaly.

---

## 1. What moves to main, what stays, and why

The renderer holds ~116 distinct pieces of state across five hooks. Only about
**11 are irreplaceable**. The rest is display state already derived from main's own
events, or deliberately lossy ephemera (cues auto-dismiss in 10s, suggestions have a
90s TTL, turn buffers are capped). Drawing the line deliberately rather than moving
everything:

### MUST move — sole copies, catastrophic if lost

| What | Where it lives now | Why it must move |
|---|---|---|
| `segments` / `segmentsRef` + the `onTranscript` builder | `useTranscription.ts:102, 148, 269-334` | The only copy of the customer's words |
| `repByEpochRef` + `resolveRole` + `identifyRep` | `useTranscription.ts:164-201, 275-307` | **Indivisible from the accumulator.** Role is baked into each segment *at record time* (`:280-281, :304`) specifically so a late change can't retroactively relabel a call. Migrating the builder without this mislabels every speaker after a reconnect, because `speakerEpoch` bumps on *every* socket open (`main/transcription.ts:535`), not just at start |
| `speakerBoundaryRef` | `useTranscription.ts:158` | Determines segment shape across epoch boundaries |
| `startedAtRef`, `startMsRef`, `durationMsRef` | `useTranscription.ts:149-151` | Persisted call metadata |
| `clipsRef` | `useLiveClips.ts:41` | **Moments the rep explicitly clicked to save.** Held in memory for the whole call, flushed only after the call save resolves (`:70-78`). The most indefensible loss on the list — deliberate user action, silently discarded |
| Deal Intelligence `LiveCallState` | `useDealIntelligence.ts` | Small, fully serializable, all fields pre-capped (tens of KB). Already has a record type, sanitizer, IPC handler and disk write — only the *timing* of the write is wrong |
| `idleWatcherRef` (auto-stop) | `LiveView.tsx:432` | **Correctness trap.** If the call survives unmount but the auto-stop watcher doesn't, an ambient auto-started call can never end itself. The comment at `LiveView.tsx:411-416` records that this previously meant "the call was never saved at all" |
| `producerIdRef` | `useTranscription.ts:138` | Main refuses audio from any other producer (`main/transcription.ts:955`). If this doesn't survive a remount, the reattaching renderer is locked out of its own live session |

### MUST move, but is easy to misclassify as display

`otherPartyLive` (`useTranscription.ts:108`) looks like a UI boolean. It is passed as
`knownRepSpeaker` into the cue engine (`LiveView.tsx:270`), which determines rep
attribution, which flows back through `identifyRep` into the saved segments' `role`
field. It is semantically load-bearing and must become main's truth.

### SHOULD move — main already has strictly more information

`useLiveCues`' `turnsRef` (capped at 80 turns) subscribes to the raw event stream
*including interim partials* (`:576, :588-599, :651`). Main **originates** those
events. So main already knows everything this buffer knows; mirroring would be
duplication. Moving it also incidentally unlocks something the post-call coach
currently gives up on: `turnsRef` is the only place per-turn timestamps exist
anywhere in the app, and `main/coaching/benchmarks.ts:7-17` documents abandoning
timing-based scoring for exactly that reason.

### STAYS in the renderer — genuine OS constraints

- **The `Recorder`** (`useTranscription.ts:129`) — `getUserMedia`, `AudioContext`,
  `AudioWorklet`, loopback capture. There is no main-process microphone API.
- **`AnalyserNode`** (`:106`) — waveform rendering, inherently a Web Audio object.
- **`getDisplayMedia`** (`:736`) requires a *live user gesture*. The code is
  explicitly structured to preserve it ("no await before getDisplayMedia, so it stays
  a user gesture", `:734`; "Synchronous, so the click's user activation survives",
  `LiveView.tsx:631`). Buyer capture can never be initiated by an async IPC round-trip
  from main. **This is a hard architectural boundary, not a preference.**

### STAYS — pure display, cheap to re-derive on attach

`phase`, `latencyMs`, `health`, `errorMessage`, all the warning banners
(`buyerSilentWarning`, `crossTalkWarning`, `multichannelFallbackNotice`), `interimText`,
`micPrompting`, `savedNotice`, `briefCopied`. Every one is already pushed by main or
is local UI trivia. Re-deriving them from a snapshot on attach is correct and simpler
than migrating them.

### Deliberately NOT persisted: coaching cues

Cues are **structurally unpersistable as written** — the hook keeps no history at all
(3 suggestions, 90s TTL, one 10s interrupt slot; `useLiveCues.ts:79, 88-89`). Most cues
are gone from memory before the call even ends. Adding persistence isn't wiring an IPC
call, it's inventing an accumulator that doesn't exist. **Out of scope for Phase 4.**
The *turn buffer* moves (above); the ephemeral cue display does not.

---

## 2. Attach / detach, and the gap

### The critical realisation

Navigating away unmounts `LiveView`, but **the renderer process stays alive** — only a
React component goes away. So the audio graph does not have to die. The fix is to move
`Recorder` ownership *above* the navigation boundary: a provider mounted in `App.tsx`
as a sibling of `MainApp`, exactly where `ActivityCenter` was placed in Phase 2 and for
exactly the same reason (`MainApp` swaps to a different tree for Settings, so anything
inside either branch vanishes on the navigation this milestone exists to fix).

This means **there is no audio gap at all on navigation.** Capture continues
uninterrupted; only the *view* detaches. That is a much stronger guarantee than
"the call resumes when you come back", and it falls out of the existing renderer
process model rather than requiring anything new.

### The gap that does exist

On **remount** (returning to Live Calls), the view must render from a snapshot it does
not yet have. The sequence:

1. `LiveView` mounts, asks main for a snapshot (`transcription:attach`).
2. Main replies with `{ sessionId, producerId, phase, segments, startedAt, durationMs, health, … }`.
3. The view renders the live call.

Between (1) and (2) there is a window — one IPC round-trip, single-digit milliseconds —
where the view has no data.

**Naming the risk explicitly, as asked:** if the view renders its *idle* state during
that window, the rep sees the "Start a call" screen while a call is running. That reads
as "my call died". This is the single most dangerous UI moment in the phase, because it
would train reps to distrust a feature that is actually working.

**The rule:** `LiveView` must have a third initial state — `attaching` — distinct from
both `idle` and `listening`, and it must be the *default* on mount, never `idle`. The
idle Start screen may only be shown once main has *affirmatively answered* "there is no
live session". A timeout on the attach request resolves to an explicit error state, never
silently to idle.

### Detach

Detach must become a first-class event distinct from stop. Concretely: delete
`void window.api.transcription.stop()` from the unmount cleanup
(`useTranscription.ts:828`) and replace it with `transcription:detach`, which tells main
"the view went away" and nothing more. **"Renderer went away" and "call ended" must stop
being the same event** — that conflation *is* BUG-046.

---

## 3. How this interacts with the BUG-046 hotfix

**A problem to fix before anything else:** the hotfix is not in this branch, and not in
`main` either. `git merge-base --is-ancestor 285acd7 HEAD` → false on
`claude/m26-engine-room`; `git branch -a --contains 285acd7` shows only
`fix/live-call-nav-data-loss`. Our task list marks it "completed" — it is committed and
tested, but stranded.

So today there are two divergent lines: one with the patch and no milestone, one with the
milestone and the bug still live.

### Order

1. **Merge `fix/live-call-nav-data-loss` → `main` first.** It's small, tested
   red-then-green, and independently valuable. This is also the release-worthy fix if you
   ever want to ship before M26 lands.
2. **Merge `main` → `claude/m26-engine-room`.** Phase 4 then gets built on top of the
   patch rather than beside it.
3. **Keep both during Phase 4.** The patch is the safety net *while* the real fix is
   being built. It costs nothing and it is the only thing protecting a transcript if I
   break something mid-phase.
4. **Remove the patch in the final Phase 4 step, not before.** With detach implemented,
   unmount no longer stops the call, so `armSave()`-on-unmount becomes unreachable dead
   code. Deleting it earlier would leave a window with neither protection.

### Does the real fix make it redundant?

Yes — and more than redundant, it makes the *entire* `savePendingRef` mechanism obsolete.
"Should this call be saved?" is a decision that belongs to the session object in main, not
to a boolean in a component that unmounts on navigation.

---

## 4. Failure modes, plainly

For each: does the call survive, is the transcript saved, what does the rep see. **Today**
means the M26 branch as it stands (without the hotfix).

### A. The session service throws mid-call

**Today:** no transcript is lost, because main holds no transcript. But `main/transcription.ts`
has **zero try/catch** on any of its three hot paths — the 1 Hz health tick (`:938`), audio
ingest (`:960`), and the socket message handler (`:576-683`, where only `JSON.parse` is
guarded). The app doesn't crash and shows nothing: two `uncaughtException` handlers exist
(`index.ts:23`, `log.ts:61`) and both only *log*, which also suppresses Electron's default
error dialog. A throwing `setInterval` keeps firing — verified empirically, 17 further ticks
after the first throw — so a health-tick fault throws once a second for the rest of the call.
The session slot is never nulled, so it stays wedged and running.

**Phase 4 inverts this risk and must pay for it.** The moment main owns `segments`, that same
throw becomes a total-loss event.

**Requirement:** journal to disk as results arrive, don't buffer in memory. Plus try/catch at
every entry point routing to one terminal `failSession` path — not defensive boilerplate: a
throw inside `ws.on('message')` silently kills the receiver with `readyState` still `OPEN` and
neither `close` nor `error` emitted, a state nothing currently watches for.

### B. Renderer crashes and reattaches

**Today: total loss, plus an unbounded leak.** No `render-process-gone` / `crashed` /
`unresponsive` handler exists anywhere in `src/main`. The session runs **forever**: the
liveness check keys off `lastAudioMs`, which is now frozen, so the health tick injects a
synthetic silence frame every 3s — exactly what Deepgram's ~10s no-audio deadline needs. **The
socket stays open and billing indefinitely**, while main keeps `webContents.send`-ing into a
dead page (`emit()` guards `window.isDestroyed()` but not `webContents.isDestroyed()`).

**Requirement:** main must own the transcript, journal incrementally, and watch
`render-process-gone` to end or park the session.

### C. Force-quit mid-call

**Today: total, silent loss.** Nothing runs — no `beforeunload`, `pagehide`, or
`visibilitychange` anywhere in `src/renderer` (zero matches), and `before-quit` never fires on
a hard kill. There is nothing on disk to recover *from*: no audio is ever written, and the
single save fires only at the end. A kill at minute 42 of a 45-minute call loses all 42.

**Requirement:** incremental journaling is the *only* thing that addresses this. An end-of-call
save is structurally incapable of surviving it. Reuse the pattern already proven in this
milestone: `jobs/store.ts:23-38` promotes anything left `running` to `interrupted` on load, and
tolerates a torn file by returning `[]`. Same shape, applied to call journals — recover an
orphaned journal into a real Call record at next launch.

### D. Deepgram drops and can't reconnect

**Today: the 60s premise is impossible — the call is dead in under 4 seconds, and the
transcript dies with it.** `MAX_RECONNECTS = 3` at 500/1000/2000ms backoff (`:723-729, :58`);
the fourth close calls `failSession` (`:731-734`), which discards the call. Worse, `failSession`
sets `savePendingRef = false` (`useTranscription.ts:265, 343`) and nulls the recorder — so this
path is **unrescuable even with the BUG-046 hotfix applied**. Separately, during any gap only
audio is buffered (10s cap) and reconnect keeps at most 3s of it, discarding the rest.

**Requirement:** a connection failure must stop being a *session* failure. Socket death should
degrade the session to `disconnected` while keeping the accumulated transcript, keeping capture,
and staying retryable.

### E. Rapid navigate-away-and-back

**Today: total loss on the first navigation.** LiveView unmounts, the listener-teardown effect
runs *before* the save effect (React cleanup order), `flushPendingSave` early-returns because
`savePendingRef` is false, and `transcription:stop` ends the call. The rep gets no warning —
there is no "call in progress" interstitial anywhere.

**Requirement:** detach ≠ stop, plus everything in §2.

---

## 5. What I am NOT touching

Drawn explicitly so it can't drift mid-phase:

- **The native audio addons** (`native/win-audio-sessions`, `native/mac-audio-activity`)
  and the ambient-detection feature that uses them.
- **Mic capture itself** — `getUserMedia`, `AudioContext`, the `AudioWorklet`, and the raw
  16-bit PCM pipeline (`recorder.ts:92-94`). Note for the record: `MediaRecorder` is used
  *nowhere* in this codebase; any design assuming a blob/media pipeline is false.
- **`getDisplayMedia` / loopback initiation** — must stay a synchronous renderer user gesture.
- **The Deepgram wire protocol**, and the queue / lag / drift / health / cross-talk trackers.
  These are M22-hardened with their own tests and recorded incident history (a removed lag cap
  that reproduced 47s of unrecovered lag). Phase 4 moves *transcript ownership*, not
  connection management.
- **The SharedArrayBuffer fast path** — hard-disabled (`pump.ts:61-63` returns literal
  `false`) because a `MessagePortMain` transferred into a Web Worker is severed on Electron.
  Not reopening that.
- **Consent** (M11) — untouched, as in every phase.

---

## 6. Prep brief's headless caller

`contextFusion.ts:49` (`const b = result.record.brief`) is the exact line that breaks on a
`{ok, jobId}` shape — and it throws *inside* the `try` opened at `:38`, so the bare `catch` at
`:62` swallows it into a normal-looking `EMPTY_CONTEXT`. No console output, no UI signal, no
unhandled rejection.

The failure isn't "the feature stops". It's **Tier 1 and Tier 2 running for the whole call with
empty deal context while nudges and the health meter keep rendering normally** — ungrounded AI
output that looks correct. A `{ok: false, jobId}` shape would be *worse*: caught by the
legitimate `!result.ok` guard at `:47`, producing identical silent degradation with no error to
find even in a debugger.

**Proposed migration — do not change the shared channel.** Keep `prepBrief:getForEvent`'s
existing response shape exactly as-is for the headless live-call caller, and add a *separate*
job-backed channel for the modal, which is the only surface where visible progress has value.
Both can safely share `ensurePrepBriefForEvent` without double-billing: it is content-hash
cached (`prep-brief-fs.ts:288`). `alerts.ts` reads the cache file directly and is unaffected.
The job must be `retainUntilConsumed: false` — the brief is already durably on disk before the
job resolves, so nothing is lost to pruning.

Two things found in passing, both pre-existing: the *modal* caller is less defensive than the
headless one (`usePrepBrief.ts:37-66` has no try/catch, and a rejection leaves it spinning
forever), and the live path bills an AI call *from inside a live call* with a 30s budget while
Tier 1's first pass fires at ~20s — so on a cold brief the context often arrives after the passes
that needed it.

---

## Phased plan within Phase 4

Each step ships independently and leaves the app working.

**4.0 — Merge the hotfix.** `fix/live-call-nav-data-loss` → `main` → `m26`. No new code.
Nothing else starts until Phase 4 is building on top of the patch.

**4.1 — Main accumulates the transcript.** Move the segment builder, `resolveRole`,
`identifyRep` and the epoch map into a `CallSession` in main. The renderer keeps rendering from
its own copy — nothing changes behaviourally. This is the largest single step and the one
everything else depends on. *Verifiable: transcripts identical before and after.*

**4.2 — Journal to disk incrementally.** Append-only JSONL per call, torn-last-line tolerant,
promoted to a real Call record at end of call, with orphan recovery at next launch. *This is
the step that actually fixes force-quit and crash.*

**4.3 — Main owns the transcript; the renderer mirrors it.** The `attaching` view state,
snapshot-on-attach, the splice-from patch protocol, `producerId` survival across remount, and
the save reading main's copy rather than the renderer's payload.

**SPLIT DURING IMPLEMENTATION.** This step originally also carried detach. It cannot: detach
means removing `void window.api.transcription.stop()` from the unmount cleanup, which leaves
the BUG-046 hotfix's `armSave()` + `flushPendingSave()` running on nav-away — saving a call
that is still in progress. `saveCall` mints a fresh `randomUUID()` per invocation with no
idempotency key, so the real end of that call writes a SECOND record: two calls in the list
for one conversation. Keeping the hotfix live until 4.7 is the stronger commitment, so detach
moved to 4.4 where its replacement lands in the same commit as its removal.

**4.4 — Detach ≠ stop, plus session robustness.** Recombined into one authorized step (the
founder's own call, once the split above happened): shipped as two commits on disjoint file
sets rather than one, since each leaves the app independently working and verifiable.

*Commit 1 — Detach ≠ stop.* Recorder ownership, hoisted above the navigation boundary.
**Correction found during implementation:** "hoist the Recorder" (the object alone) does not
work — `armSave()`/`flushPendingSave()` live inside `useTranscription`, not inside the raw
Recorder, so as long as `useTranscription` was still instantiated inside `LiveView` those
lines would keep firing on every navigation regardless of where the Recorder object lived.
The actual fix hoists the *whole hook instantiation* into `LiveCallProvider`, mounted once in
`App.tsx` above `MainApp` (the same shape `ToastProvider` already uses). One further
correction: the hotfix's own `stop()` call does **not** become `detach()` — once
`useTranscription` lives in the Provider, that effect only fires on a genuine
provider-level teardown (in practice: sign-out), where ending the call outright is still
correct. Ordinary navigation now fires a different, new effect in `LiveView` instead.
`useTranscription.ts` ends up with **zero lines changed**.

*Commit 2 — Session robustness.* try/catch at the three named entry points (health tick,
audio ingest, the socket message handler), routed through a shared repeat-fault threshold
rather than ending the session on the first throw (today's accidental tolerance for a
one-off fault is more permissive than a hair-trigger threshold would be — matching it, not
tightening it, was the actual goal). `render-process-gone` handling, so a crashed renderer's
session no longer runs (and bills) forever. Main's own end-of-call trigger — never a real
`saveCall`, always a journal-close-unsaved, recovered the same way any other interrupted call
is. A `saveInFlight` latch closes a race that trigger introduces: a main-initiated
`endCall({saved:false})` landing while a real save is in flight would otherwise leave a
successfully-saved call's journal without its `.done` marker, offering it for recovery and
minting a duplicate `Call` record.

**Known gap, named rather than silently bundled:** `drain()` has its own unguarded
`setInterval` and `ws.on('open')` call site, separate from `ingestAudio` (wrapping
`ingestAudio`'s body only covers a throw reached *via* `ingestAudio`, not drain's other two
entry points). Not one of the three explicitly-named paths, so left unwrapped for this
step — a fault there still only reaches today's status quo (the process-wide
`uncaughtException` logger), not a regression, just an inconsistency worth closing later.

**4.5 — Move the live engines.** Deal Intelligence `LiveCallState` and the cue turn buffer into
the session; write the Radar Report from main rather than from a renderer callback.

**4.6 — The live-call pill.** A persistent indicator, sibling of `MainApp` like ActivityCenter,
so an ongoing call is visible from every screen.

**4.7 — Remove the hotfix's now-dead code**, and the `savePendingRef` mechanism with it.

Also **required in 4.7, not optional** (added during 4.2): retire `*.jsonl.recovered`
journals. 4.2 keeps every recovered journal on disk forever, deliberately — while
journaled recovery is new, a replay that produces something subtly wrong is still
plausible, and cleaning up early destroys the only evidence available to diagnose it.
That reasoning expires exactly when the mechanism stops being new, which is the end of
Phase 4. Without this, the "deliberate" part quietly becomes an unbounded directory that
nobody ever revisits. Retention should follow the same shape as the job-history cap:
a count, not a time window.

---

## Testing, and what only you can verify

**Automated (me):** the segment builder + role resolution move to main, which makes them
*directly unit-testable for the first time* — currently they're trapped in a React hook. Journal
write/recover round-trips, including a deliberately torn last line. Attach-snapshot shape.
Detach-doesn't-stop. Reconnect epoch handling (the mislabeling risk). Red-then-green on every
data-loss path.

**Only you, on a real call** — the simulator cannot prove any of these:

1. **Navigate away mid-call and back**, several times, including into Settings. Transcript
   intact, no gap in words, no "call died" flash.
2. **A genuinely long call** (20+ min) — journal growth, no memory creep, no lag drift.
3. **Real network interruption** (turn off wifi ~30s). Does it degrade and recover rather than
   dying at 4 seconds?
4. **Force-quit mid-call via Task Manager**, then relaunch. Is the call recovered?
5. **Buyer capture (loopback)** — the user-gesture path can't be automated at all.
6. **Pause/resume** mid-call, given what the research turned up about pause (below).

---

## Bugs found during research — decisions needed before I build

These are pre-existing, none introduced by Phase 4, and all are data-loss or
tells-you-something-false. Per our standing rule I'm flagging rather than fixing.

1. **The Stop button silently loses short calls.** `armSave` latches a *snapshot*:
   `savePendingRef.current = segmentsRef.current.length > 0` (`useTranscription.ts:204-209`),
   never re-evaluated. Stop arms while segments are empty → Deepgram's `Finalize` then delivers
   the only words of the call → `flushPendingSave` bails at `:214` because the flag already
   latched false. **Any call short enough that all speech was still interim at Stop is lost
   through the ordinary Stop button.** Not an edge case.

2. **The quit dialog asserts something false.** `index.ts:509` tells the rep "a live call is
   saved first either way". It isn't, in either branch. This is worse than a missing feature —
   it reassures someone at the exact moment their call is being destroyed.

3. **Pause destroys engine state, permanently.** Both engines treat `status === 'listening'` as
   liveness (`LiveView.tsx:267, :293`), so a normal Pause runs a full per-call reset. For Deal
   Intelligence the damage survives a *successful* save: `reset()` snapshots into
   `finalizedReportRef` on pause, then `reset()` at call end overwrites that snapshot with
   post-resume-only data. The Radar Report silently covers only part of the call.

4. **A failed save is silent and unrecoverable.** `flushPendingSave` consumes the pending flag
   *before* the async save and swallows rejections with an empty catch (`:249-251`) — no retry,
   no re-arm, no error. Its own comment says "non-fatal: the transcript is still on screen", but
   on the unmount and quit paths the screen is exactly what just went away.

5. **A crashed renderer bills Deepgram indefinitely** (§4B). Not data loss, but real money.

My recommendation: **(1) and (2) are worth fixing immediately as small standalone commits**,
before 4.0 — (1) is active data loss through the primary button, and (2) is a two-word honesty
fix. (3) and (4) fall out naturally from 4.2/4.5 and are better fixed there than twice. (5)
belongs in 4.4.
