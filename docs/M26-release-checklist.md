# M26 The Engine Room — release checklist (v1.1.10 → v1.2.0)

This milestone touches the two things in this app where a bug costs the
most: **live-call transcript ownership moved into main** (the failure mode
is losing a real customer conversation — the exact class of bug this
milestone exists to prevent, not just add to), and **every AI-call site's
fallback/retry/cooldown machinery got rewritten** (BUG-057/058/059/060).
Both are already covered by a large automated suite (1734 tests, run clean
on the merge — see below), but neither is fully verifiable without a real
call on a real machine. Treat every unchecked box below as a real gate, not
ceremony — this is explicitly staged, not published, specifically so a
human does the boxes only a human can check before this goes out.

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
- **AI reliability** (BUG-057, fully fixed; BUG-059, BUG-060, fixed): a
  wall-clock ceiling per job type (no more 27-minute hangs), real
  cancellation wired through ~10 job types, per-model cooldowns with a
  failure taxonomy (transient/period-exhausted/structural), escalating
  backoff, tiered cooldown bypass for durable purposes, and a Settings
  notice when a purpose is quietly substituting providers or genuinely
  failing.
- **Scheduler infrastructure** (Phase 5, partial): Sales Brain's nightly
  consolidation moved off a hand-rolled timestamp file onto shared
  scheduler hooks. Settings for job concurrency and completion
  notifications.

## What's explicitly NOT in this release — read before assuming otherwise

- **BUG-058 (free-tier rate-limit spiral) is still OPEN.** This was the
  founder's own stated #1 priority ("the highest priority in M26, above
  everything") and remains only partially fixed: per-model cooldown +
  Gemini backoff shipped (commit `7660967` + two correction commits), but
  the rest — quota-type-specific messaging ("Gemini's daily quota is used
  up, resets in ~4h" vs. a generic failure), pre-call capability checks
  (skip a model that can't succeed instead of spending a request to find
  out), stopping the walk early on a systemic failure — is only sketched
  in the Bug Tracker's prose, not a reviewed phased design the way
  BUG-057 had. **A user with 1-2 free-tier keys may still hit failures
  this release does not fully solve.** Don't ship release notes implying
  this is closed.
- **Phase 4.5.3 onward (moving cue/Deal-Intelligence engine STATE into
  main) is paused, deliberately**, not incomplete by accident. BUG-055
  already closed the specific bugs that work targeted (replay storm,
  missing consent gate) via a lower-risk mechanism. The remaining gap —
  cue/nudge/health-score state doesn't survive a renderer CRASH the way
  the transcript now does — is real but narrower than originally scoped.
  See the M26 vault doc's own writeup for the full reasoning; this is
  flagged for the founder's review, not something this checklist can
  resolve on its own.
- **macOS is unverified for this milestone's live-call changes.** All
  development and testing happened on Windows. `LiveCallProvider`'s hoist
  and the transcript ownership change are platform-agnostic in principle
  (pure React/main-process code, no OS-specific APIs touched), but "should
  work" and "verified working" are different claims — don't let this ship
  as "cross-platform confirmed."

## Before this goes out — automated (already done, verify the state)

- [x] `npm run typecheck` clean on the merged `main` (real command — see
      the taxonomy note below on why "real command" is worth stating
      explicitly for this milestone specifically).
- [x] `npx vitest run` — full suite, 1734 tests, 0 failures, on the branch
      before merge.
- [x] `main` merged cleanly (`claude/m26-engine-room` was a pure
      fast-forward-equivalent — 0 divergent commits on `main`'s side, no
      conflicts to resolve, nothing to double-check for a bad merge
      resolution).
- [x] Version bumped 1.1.10 → 1.2.0 (`package.json` + `package-lock.json`,
      minor bump — this is a real feature milestone, not a patch).
- [x] Windows installer built locally (`npm run native:build:win && npm
      run build && npx electron-builder --win --publish=never`) —
      explicit `--publish=never`, confirmed nothing was uploaded anywhere
      (the full build log has zero mentions of publish/upload/GitHub
      release). Two artifacts, both x64+arm64, in `dist/`:
      `CallRise AI Windows.exe` (NSIS installer, ~328MB, code-signed) and
      `CallRise AI Windows Portable.exe` (~167MB, code-signed). Neither
      has been run/installed/smoke-tested — that's the first item in the
      "needs a human" section below, not assumed from a successful build.
- [ ] **The real command matters, and it silently didn't for part of this
      milestone**: `npx tsc --noEmit` run bare at the repo root checks a
      `tsconfig.json` with `files: []` and is a silent no-op — always
      "clean," always checking zero files, discovered mid-milestone (see
      the vault doc's taxonomy species 9). Every "clean typecheck" claim
      above used `npm run typecheck`. If you re-verify anything yourself,
      use that command, never bare `tsc`.

## Before this goes out — needs a human, on a real Windows machine

**0. Run the built installer.** A clean `electron-builder` exit only proves
packaging succeeded — it does not prove the installer actually installs,
launches, and runs on a real machine. Install `CallRise AI Windows.exe`
(or run the portable one) fresh, confirm the app launches, signs in, and
the version shown in Settings reads 1.2.0. This is step zero, before
anything below — an installer that doesn't install makes every other item
on this list moot.

**The founder's own headline test for this whole milestone — do this
first once the app is actually running, it's the one thing automated
tests structurally cannot prove:**

1. **Start a live call. Navigate away (Settings, then back; a different
   sidebar item, then back) several times while the call keeps running.**
   Confirm: no duplicate coaching cues, no duplicate Deal Intelligence
   nudges, the transcript is continuous with nothing missing or
   duplicated, and the live-call pill is visible and correct on every
   screen you navigate to.
2. **Toggle buyer-side recording on/off mid-call**, more than once.
   Confirm coaching/Deal Intelligence don't reset or re-fire, and that
   revoking consent actually stops buyer-attributed content from reaching
   an AI prompt (BUG-055's fix) — this needs a debug log check or similar,
   not just watching the UI, since the fix is a silent skip.
3. **Force-quit or crash the app mid-call** (not a clean Stop). Relaunch.
   Confirm the interrupted-call prompt correctly offers to recover it, the
   recovered transcript is complete (or honestly marked truncated if the
   very last utterance was mid-flight), and starting a NEW call afterward
   is not contaminated by anything from the crashed one.
4. **A genuinely long call (20+ minutes)** with Deal Intelligence and
   coaching cues both on. Watch for nudge-history growth, cooldown drift,
   or the health score behaving differently late in the call than it did
   early on — the kind of slow drift a short automated test can't surface.
5. **Exercise the job system for real**: run 2-3 background operations at
   once (a summary, a CRM note generation, a sync) and confirm they queue/
   run according to the lane limits shown in Settings → App, Cancel
   actually stops an in-flight one (not just hides it — BUG-060's whole
   point), and the Activity Center survives a trip through Settings.
6. **Confirm a fresh profile still works end-to-end** — a brand-new
   install, one or two free-tier keys configured, a live call, a summary.
   This is exactly the scenario BUG-058 (still open) is about; confirming
   the app is at least USABLE (even if not perfectly resilient) on this
   path matters before shipping.
7. **Job concurrency / notification Settings**: open Settings → App,
   confirm the new "Background job concurrency" and "Background job
   notifications" controls are visible, change a value, confirm it takes
   effect without restarting (queue more jobs than the new limit and watch
   them actually queue).

## Rollback instructions (if something goes wrong post-push)

1. **First, confirm whether it's live-call-specific or app-wide.** If
   regular use (CRM, calendar, tasks) is fine and only live calls are
   affected, that's the highest-severity failure mode this milestone could
   produce — treat it as urgent regardless of how few users report it.
2. **If live calls are losing data again** (the exact class of bug BUG-046
   and Phase 4 exist to prevent): this is the one scenario that justifies
   an emergency patch ahead of a full investigation. The transcript-journal
   mechanism (`live-transcript.ts`, `call-journal.ts`) is independent of
   everything else in this milestone — if it's broken, a patch that
   reverts just the `LiveCallProvider` hoist (Phase 4.4) back to
   `LiveView`-local hooks is a smaller, more surgical rollback than
   reverting the whole milestone, and worth trying first.
3. **If it's the job system misbehaving** (jobs stuck, wrong lane
   ordering, a job silently not running): lower-severity than #2 — nothing
   here risks losing already-saved data, since job persistence write paths
   were extensively tested. A patch fixing the specific bug is preferable
   to a rollback; the job system underlies ~15 features at this point, so
   reverting it wholesale would be a large regression in its own right.
4. **If it's an AI-reliability regression** (BUG-057/058/059/060 work):
   check whether it's isolated to one purpose/provider before assuming the
   whole fallback chain is broken — the taxonomy/cooldown changes are
   per-catalogId, so a bad interaction with one specific provider's error
   shape is more likely than a systemic break.
5. **There is no server-side rollback** — recovery is always a new patch
   release or, for live-call data specifically, the existing
   crash-recovery journal mechanism (unaffected by anything going wrong at
   the UI/settings layer).

## Post-push monitoring

- [ ] Watch for any report of a live call not appearing in Past Calls, or
      appearing truncated/duplicated — this is the single highest-priority
      signal to watch for in the first 48 hours, given what this milestone
      touches.
- [ ] Watch for duplicate coaching cues or Deal Intelligence nudges
      specifically after a screen navigation mid-call — the exact symptom
      BUG-055 fixed; a regression here would mean the fix didn't hold.
- [ ] Watch free-tier-key users' reports specifically — BUG-058 remains
      open, so failures here are expected to still occur; the useful
      signal is whether they're WORSE than before this release (would
      indicate a regression in the cooldown/backoff work) rather than
      merely present.
- [ ] Spot-check that job concurrency/notification settings default
      correctly (2/1/1, notifications on) for users updating from a
      pre-M26 version, not just fresh installs.

## Known, accepted gaps at ship time

- BUG-058 (free-tier rate-limit spiral) — open, see above.
- Phase 4.5.3+ (cue/Deal-Intelligence state surviving a renderer crash) —
  paused, see above.
- macOS — unverified for this milestone's changes.
- Per-category (vs. master on/off) notification filtering — not built;
  there's no `category` field on `Job` today, see
  `docs/M26-job-adapter-guide.md` for what adding one would take.
- The auth-exclusion test fix and this checklist's own drafting happened
  in the same overnight session as everything else above — normal
  same-session review discipline applied (real typecheck, red-check before
  green, no `expect(true).toBe(true)`), but this entire release has not
  had a SEPARATE, second-pass review by anyone other than the same session
  that wrote it. Worth weighing before treating "tests pass" as equivalent
  to "reviewed."
