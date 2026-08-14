# M26 The Engine Room — release checklist (v1.1.10 → v1.2.0)

This milestone touches the two places in this app where a bug costs the
most: **live-call transcript ownership moved into main** (the failure mode
is losing a real customer conversation — the exact class of bug this
milestone exists to prevent, not just add to), and **every AI-call site's
fallback/retry/cooldown machinery got rewritten** (BUG-057/058/059/060,
all now fully fixed). It is also the first release carrying the entire new
**job system** (per-lane concurrency, cancellation, crash-resume, Activity
Center) — ~15 existing operations moved onto it. Three large, cross-cutting
subsystems in one release. Treat every unchecked box below as a real gate,
not ceremony.

> **⚠️ THE STAGED 1.2.0 BUILD IS STALE — re-merge and rebuild before
> publishing. READ THIS FIRST.**
>
> The overnight publish-staging pass merged `claude/m26-engine-room` into
> `main`, bumped to 1.2.0, and built an installer — but that was **before**
> BUG-058 was actually closed. Since then, four commits landed on
> `claude/m26-engine-room` that are **NOT** in `main` or the staged
> installer:
> - `35d4bba` BUG-058 Phase 1 (cross-purpose pacing)
> - `37b521a` BUG-058 Phase 2 (systemic early-exit + streamWithFallback parity)
> - `125b3d7` BUG-058 Phase 3 (honest quota messaging)
> - `f2ff555` BUG-057 Phase 6 follow-up (visible tool-capability exclusion)
>
> BUG-058 was the founder's own stated release gate ("nothing publishes
> until the manual pass is done and BUG-058 is closed"). The staged
> installer predates its fix, so **it must not be the artifact that ships.**
> Pre-publish, in order: (1) merge `claude/m26-engine-room` into `main`
> again — it carries these four commits plus this updated checklist; (2)
> confirm `package.json` on `main` reads 1.2.0 (the bump already landed on
> `main`; this branch is still 1.1.10, so the merge must not regress it —
> verify after merging); (3) rebuild the installer from the merged `main`;
> (4) then do the human-verification boxes below against that fresh build.

## What's actually in this release

- **Job system** (Phase 1-3): a real per-lane concurrency queue
  (LIVE unbounded / INTERACTIVE 2 / BATCH 1 / MAINTENANCE 1, now
  user-adjustable in Settings → App), cooperative cancellation, crash
  persistence/resume, an Activity Center (toasts, native notifications
  with call-aware do-not-disturb, taskbar progress, a "still working" quit
  guard). ~15 existing operations (summarize, CRM notes, backup sync,
  Sales Brain backfill/nightly consolidation, deal risk, calendar
  reconcile, updater download, ...) migrated onto it.
- **Live-call redesign** (Phase 4, 4.5.0-4.5.2, 4.6-4.7): the transcript
  moved into main (survives navigation AND a renderer crash, journaled to
  disk, recoverable). The whole recording session hoisted above the
  navigation boundary (`LiveCallProvider`) so "screen unmounted" and "call
  ended" are finally two different events. A persistent live-call
  indicator now shows outside the Live Calls screen too. BUG-055
  (standalone, merged ahead of this) fixed a real reset/replay bug in the
  coaching-cue and Deal Intelligence engines and added the consent gate
  they were missing.
- **AI reliability — BUG-057/058/059/060, all fully fixed:**
  - A wall-clock ceiling per job type (BUG-059 — no more 27-minute hangs),
    real cancellation wired through ~10 job types (BUG-060).
  - Per-model cooldowns with a failure taxonomy
    (transient/period-exhausted/structural), escalating backoff, tiered
    cooldown bypass for durable purposes, pre-call tool-calling capability
    check, a 3-way wait/add-key/report-a-bug message classifier, and a
    Settings notice when a purpose is quietly substituting providers or
    genuinely failing (BUG-057, all six phases + parts 2-3).
  - **BUG-058, all three of its own phases** — the free-tier rate-limit
    spiral, re-diagnosed midway against this machine's real fallback log:
    the dominant cause was **shared-resource contention** across ~10 AI
    purposes sharing 1-2 free-tier keys, not any single purpose's retry
    logic.
    - *Phase 1 — cross-purpose pacing*: several durable purposes wanting
      the same model within a few seconds spread across their own fallback
      candidates instead of all colliding on it (a skip, not a wait — zero
      added latency when a chain has another viable entry).
    - *Phase 2 — systemic early-exit + `streamWithFallback` parity*:
      `streamWithFallback` had no early-exit at all before (a real
      asymmetry); plus a same-provider-twice-in-one-walk heuristic on both
      walks.
    - *Phase 3 — honest quota messaging*: real reset times where a provider
      actually exposes them (Anthropic, OpenRouter), a documented fixed
      schedule where one is published (Groq, Gemini), and an explicit "we
      don't know when it resets" everywhere else — never a guessed duration.
      A new `quota-exhausted` state lets live coaching/Deal Intelligence
      show the real reason instead of a generic "unavailable."
- **BUG-057 Phase 6 follow-up** (the last deferred item): a stale
  `supportsToolCalling: false` catalog flag is no longer *silently*
  excluded — the exclusion now surfaces in the fallback-event log
  (Settings → Model Assignment), diagnosable instead of invisible. Filter
  behavior is unchanged; only its visibility.
- **Scheduler infrastructure** (Phase 5): Sales Brain's nightly
  consolidation moved off a hand-rolled timestamp file onto shared
  scheduler hooks. Settings for job concurrency and completion
  notifications. A job-adapter guide (`docs/M26-job-adapter-guide.md`) for
  the next migration.

## What's explicitly NOT in this release — read before assuming otherwise

- **Phase 4.5 is formally closed at 4.5.2 — founder's decision, 2026-08-14,
  FINAL (not provisional).** 4.5.3 onward (moving cue/Deal-Intelligence
  engine STATE into main) will not be built. BUG-055 already closed the
  specific bugs that work targeted (replay storm, missing consent gate) via
  a lower-risk mechanism, and the transcript provably survives a renderer
  crash without it.
  - **Evidence this is safe** (a real crash test, not a code read):
    `src/main/session-health/__tests__/render-process-gone.test.ts` drives
    the actual `ipcMain` handlers and a real Deepgram-shaped WebSocket
    server, crashes the renderer for real, then asserts
    `listRecoverableCalls()` returns the call and `readJournal(callId)`
    still contains the spoken-word events. The transcript is journaled
    per-turn in main, independent of any renderer state;
    `handleRenderProcessGone()` → `endCall({saved:false})` *closes* the
    journal (never deletes it — recoverable orphan, same Interrupted Call
    flow already shipped).
  - **Known, accepted limitation — for the release notes:** *a renderer
    crash mid-call loses coaching-cue history and Deal Intelligence
    health/nudge state; the transcript and all saved data survive via the
    journal.* On next attach after such a crash, the cue list and Deal
    Intelligence panel start empty for the rest of that call. Nothing
    durable is lost.
  - **Frequency deliberately unquantified**: no crash-frequency telemetry
    exists in this codebase (no analytics pipeline of any kind). No number
    was invented to close this. Revisitable if a real user reports losing
    cue/health continuity often enough to matter, or if crash telemetry is
    added later — build the narrow crash-survival slice then, with real
    numbers to size it. Not preemptively.
- **macOS is unverified for this milestone's live-call changes.** All
  development and testing happened on Windows. `LiveCallProvider`'s hoist
  and the transcript ownership change are platform-agnostic in principle
  (pure React/main-process code, no OS-specific APIs touched), but "should
  work" and "verified working" are different claims — don't let this ship
  as "cross-platform confirmed."
- **Per-category (vs. master on/off) notification filtering** — not built;
  there's no `category` field on `Job` today. See
  `docs/M26-job-adapter-guide.md` for what adding one would take.
- **Pre-call context-window checks** (a deferred BUG-058 idea) — not built.
  No token-counting infrastructure exists to build it on, and nothing in
  the real fallback log shows a context-length failure. Logged as deferred
  with reasoning in `docs/BUG-058-shared-resource-pacing-design.md`, not
  silently dropped.

## Before this goes out — automated (state to re-establish AFTER the re-merge)

The boxes below were green on `claude/m26-engine-room`'s current tip. But
per the stale-build warning at the top, the **merged `main` + rebuilt
installer** is what actually ships, so these must be **re-confirmed on the
merged `main`**, not taken from this branch.

- [x] `npm run typecheck` clean on `claude/m26-engine-room` tip (real
      command — see the note below on why "real command" is worth stating).
- [x] `npx vitest run` — full suite, **1775 passed / 5 skipped**, on
      `claude/m26-engine-room` tip.
- [ ] **Re-merge `claude/m26-engine-room` → `main`** (brings the four
      BUG-058 + follow-up commits and this checklist). Verify `package.json`
      on the merged `main` still reads **1.2.0** (the bump lives on `main`;
      this branch is 1.1.10 — the merge must not regress it).
- [ ] **Re-run `npm run typecheck` and `npx vitest run` on the merged
      `main`** — confirm still clean there, not just on the branch.
- [ ] **Rebuild the installer from merged `main`**: `npm run
      native:build:win && npm run build && npx electron-builder --win
      --publish=never`. Keep the explicit `--publish=never`; confirm the
      build log has zero mentions of publish/upload/GitHub release. The
      previously-staged `dist/` artifacts are STALE (pre-BUG-058) — discard
      them, do not ship them.
- [ ] **The real command matters, and it silently didn't for part of this
      milestone**: `npx tsc --noEmit` run bare at the repo root checks a
      `tsconfig.json` with `files: []` and is a silent no-op — always
      "clean," checking zero files (discovered mid-milestone; see the vault
      taxonomy species 9). Every "clean typecheck" claim uses `npm run
      typecheck`. If you re-verify anything yourself, use that, never bare
      `tsc`.

## Before this goes out — needs a human, on a real Windows machine

*Only the founder can check these — automated tests structurally cannot
prove a real call on a real machine behaves. Do them against the freshly
rebuilt (post-re-merge) installer, not the stale one.*

**0. Run the built installer.** A clean `electron-builder` exit proves
packaging succeeded, not that the installer installs, launches, and runs.
Install the freshly rebuilt `CallRise AI Windows.exe` (or run the portable
one) on a real machine, confirm the app launches, signs in, and Settings
shows version **1.2.0**. Step zero — an installer that doesn't install
makes everything below moot.

1. **Live-call navigation.** Start a call. Navigate away (Settings, then
   back; a different sidebar item, then back) several times while it keeps
   running. Confirm: no duplicate coaching cues, no duplicate Deal
   Intelligence nudges, the transcript continuous with nothing missing or
   duplicated, and the live-call pill visible and correct on every screen.
2. **Buyer-capture toggle mid-call**, more than once. Confirm coaching/Deal
   Intelligence don't reset or re-fire, and that revoking consent actually
   stops buyer-attributed content from reaching an AI prompt (BUG-055) —
   needs a debug-log check, not just the UI, since the fix is a silent skip.
3. **Force-quit / crash mid-call** (not a clean Stop). Relaunch. Confirm
   the interrupted-call prompt offers to recover it, the recovered
   transcript is complete (or honestly marked truncated if the last
   utterance was mid-flight), and a NEW call afterward is not contaminated
   by the crashed one. *(Note the accepted limitation: coaching-cue and
   Deal Intelligence history for the crashed call WILL be empty on recovery
   — that's expected and documented, not a bug. The transcript is what must
   survive.)*
4. **A long call (20+ minutes)** with Deal Intelligence and coaching cues
   both on. Watch for nudge-history growth, cooldown drift, or the health
   score behaving differently late vs. early — slow drift a short automated
   test can't surface.
5. **Job system for real.** Run 2-3 background operations at once (a
   summary, a CRM note, a sync). Confirm they queue/run per the lane limits
   in Settings → App, Cancel actually stops an in-flight one (not just hides
   it — BUG-060's whole point), and the Activity Center survives a trip
   through Settings.
6. **BUG-058, the release gate — a free-tier-only profile under real
   pressure.** This is the one to spend the most time on; it's why the
   release was gated. A fresh install with only 1-2 free-tier keys, then
   drive real load: start a live call (coaching cues + Deal Intelligence
   both on) AND kick off a couple of background jobs (a summary, a Sales
   Brain backfill) so several purposes contend for the same keys at once —
   exactly the shared-resource-contention scenario BUG-058 Phase 1 targets.
   Confirm:
   - The app does **not** spiral into total failure after 1-2 operations
     the way it did before (the founder's own demo-machine symptom).
   - When a model genuinely rate-limits, you see a *specific* message — a
     real reset time where the provider gives one, or an honest "we don't
     know when it resets," or "add another key" — **never** a generic
     "something went wrong," and never a confidently-wrong duration.
   - Coaching cues / Deal Intelligence show a real paused reason (quota
     exhausted vs. rate-limited vs. timed out), not a blank stall.
7. **Sales Brain backfill rerun.** Rerun the history backfill now that the
   chain + messaging work has landed. Confirm it respects per-call "don't
   learn from this" and the master pause switch (BUG-056), and that its
   many rapid AI calls no longer spiral the shared keys (BUG-058) — this is
   the highest-volume real exercise of the pacing/cooldown work on a single
   machine.
8. **Job concurrency / notification Settings.** Settings → App: confirm the
   new "Background job concurrency" and "Background job notifications"
   controls are visible, change a value, confirm it takes effect without a
   restart (queue more jobs than the new limit, watch them queue).

## Rollback plan — first release carrying the whole job system + live-call rework

There is **no server-side rollback** — every recovery path here is a new
patch release (or, for live-call data specifically, the crash-recovery
journal, which is independent of everything else and unaffected by a
UI/settings-layer failure). Because three large subsystems ship together,
the goal below is a **surgical** revert of the one at fault, not reverting
the whole milestone — a wholesale revert would regress ~15 features that
now depend on the job system.

**Step 0 — triage which subsystem.** Determine whether the problem is
live-call-specific, job-system, or AI-reliability before touching anything.
If regular use (CRM, calendar, tasks) is fine and only live calls are
affected, that is the highest-severity class this milestone can produce —
treat it as urgent regardless of how few reports.

1. **Live calls losing/corrupting data** (the exact class BUG-046 and Phase
   4 exist to prevent) — the one scenario that justifies an emergency patch
   ahead of a full investigation.
   - The transcript-journal mechanism (`live-transcript.ts`,
     `call-journal.ts`) is independent of the rest of the milestone. If a
     journaled call still recovers correctly, saved data is safe and this
     is less urgent than it looks.
   - Most surgical revert: back out just the `LiveCallProvider` hoist
     (Phase 4.4) to `LiveView`-local hooks, leaving the transcript-in-main
     journaling in place. Smaller and safer than reverting all of Phase 4.
   - Tag to revert toward: the pre-M26 release tag (last 1.1.x). Confirm the
     exact tag with `git tag --list` before the release, and record it here
     so it's not hunted for under pressure.
2. **Job system misbehaving** (jobs stuck, wrong lane ordering, a job
   silently not running) — lower severity than #1: job persistence write
   paths were extensively tested, so already-saved data is not at risk.
   Prefer a targeted patch to the specific bug over a revert; the job system
   underlies ~15 features, so reverting it wholesale is itself a large
   regression. If a revert is truly needed, the job-adapter migrations are
   per-operation — a single misbehaving operation can often be pointed back
   at its pre-job direct call without touching the others.
3. **AI-reliability regression** (BUG-057/058/059/060 work) — check whether
   it's isolated to one purpose/provider before assuming the whole fallback
   chain broke. The cooldown/pacing/taxonomy changes are per-`catalogId`, so
   a bad interaction with one provider's specific error shape is far more
   likely than a systemic break. The three module-level maps
   (cooldown/pacing/structural-break) are all in-memory and reset on
   restart, so "restart the app" is a real, immediate mitigation while a
   patch is prepared. `PACING_GAP_MS` (`model-pacing.ts`) and the cooldown
   constants are single named values — if pacing is too aggressive in the
   field, raising or zeroing one constant is a one-line patch, not a
   redesign.
4. **Quota messaging is wrong** (a reset time that's off, or a provider
   whose header we misread) — lowest severity, cosmetic-ish: the message is
   wrong but the fallback still works. `resetsAt` is messaging-only; it
   never gates a retry. A patch to the specific provider's parser is
   isolated to that adapter. Worst case, the honest "we don't know when it
   resets" branch is always safe to fall back to.

## Post-push monitoring (first 48h)

- [ ] **Highest-priority signal:** any report of a live call not appearing
      in Past Calls, or appearing truncated/duplicated. This is what the
      whole live-call rework risks; watch it first.
- [ ] Duplicate coaching cues or Deal Intelligence nudges after a mid-call
      navigation — the exact symptom BUG-055 fixed; a regression means the
      hoist didn't hold.
- [ ] **Free-tier-key users specifically** — BUG-058 is now *fixed*, so the
      signal has flipped: previously "failures expected," now watch for
      whether the spiral is genuinely *gone*. A report of the app still
      dying after 1-2 operations on free keys would mean the pacing/early-
      exit work didn't hold in the field. Also watch for any quota message
      that names a wrong reset time (a provider-header misread — see
      rollback #4).
- [ ] Job concurrency/notification settings default correctly (2/1/1,
      notifications on) for users **updating** from a pre-M26 version, not
      just fresh installs.
- [ ] Any spike in "AI paused / unavailable" that correlates with the new
      pacing — if pacing is too aggressive it would present as coaching/Deal
      Intelligence pausing more often than the underlying rate limits
      actually warrant (rollback #3's one-line constant patch).

## Known, accepted gaps at ship time

- A renderer crash mid-call resets cue/Deal-Intelligence state (never the
  transcript) — accepted, final scope decision (Phase 4.5 closed at 4.5.2),
  not tracked as a bug.
- macOS — unverified for this milestone's changes.
- Per-category (vs. master on/off) notification filtering — not built.
- Pre-call context-window checks — deferred with reasoning (see BUG-058
  design doc).
- NVIDIA/Cerebras/Mistral quota-reset headers — unconfirmed by research;
  they correctly fall back to the honest "we don't know when it resets"
  message rather than guessing. Confirm their real 429 shape in a follow-up
  only if they turn out to matter in practice.
- **Review provenance:** the BUG-058 phases, the tool-capability follow-up,
  and this checklist were all written in the same working sessions as the
  rest of the milestone. Standard discipline was applied throughout (real
  `npm run typecheck`, red-check every new test by reverting the fix and
  confirming failure, no vacuous assertions, derived-not-guessed constants
  labeled as such). But this release has not had a **separate, second-pass
  review** by anyone other than the sessions that produced it — weigh that
  before treating "tests pass" as equivalent to "independently reviewed."
