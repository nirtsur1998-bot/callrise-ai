# Overnight deep audit — findings

**Run:** 2026-08-25, worktree `C:\Users\User\Desktop\callrise-audit`, branch `claude/overnight-audit`,
off `main` @ `f5d357e` (== `origin/main` at start of run).
**Environment for every claim:** Windows 11 Pro 22631, Node v24.18.0, vitest 4.1.10,
`node_modules` freshly installed for this worktree.

---

## ⚠️ READ THIS FIRST — THE VERIFICATION STATUS OF THIS DOCUMENT

**The adversarial verification pass did NOT run.** It was launched and was killed
by a session usage limit along with seven other agents. The plan was that every
Critical/High claim would face an agent whose only job was to refute it, and only
survivors would appear here. That did not happen.

So this document is **Phase 0 output, not a verified findings list.** Every finding
below carries the reporting agent's own confidence and its own "what I could not
verify" note, preserved verbatim rather than smoothed over. Treat them as
**high-quality leads with file:line evidence**, not as established defects.

**Five branches now exist, all off `main`, all UNPUSHED, and none of them is this branch**
(this one still contains only this document):

| Branch | Commit | What |
|---|---|---|
| `fix/BUG-115-deal-intelligence-consent` | `59937f5` | **CONSENT LEAK** — the Radar Report kept the buyer's verbatim words after revocation |
| `fix/BUG-111-pause-ends-call` | `47a44f3` | pause >10s ended the call |
| `fix/BUG-114-regenerate-stale-draft` | `98fb4be` | "Regenerate" served the rejected draft |
| `fix/preload-escape-hatch` | `732687a` | removed the arbitrary-channel IPC bridge |
| `fix/BUG-112-sync-failure-comment` | `6f845da` | corrected a false load-bearing comment (comment only) |

Each of those five was independently verified before being fixed. **Everything else in this
document remains untouched and unverified**, and a second wave of auditors (consent,
IPC/security, packaging, detection) has since added findings that are also unverified —
see §10.

Two consequences worth stating plainly:

1. **Do not act on a CRITICAL below without re-deriving it.** The three most severe
   findings (LIVE-1, CAL-1, CAL-4) are each a single agent's reading. They are
   specific and well-evidenced, but one reading is not verification — that is
   taxonomy species 13's whole lesson.
2. **Absence of a finding in an area means nothing tonight.** Eight of thirteen
   agents died mid-flight. Coverage is listed honestly in §6.

---

## 1. FIELD-CRITICAL — the unmissable ones

Ranked by (severity × how easily a normal user reaches it). All three are
**UNVERIFIED BY A SECOND PASS.**

### LIVE-1 — Pausing a live call for 10 seconds ends the call
**Severity: CRITICAL · Field-critical: yes · ✅ CONFIRMED and FIXED**

> **This is the one exception to the "unverified" banner above.** I ran the adversarial
> pass on it by hand and closed every refutation route (see the checklist at the end of this
> entry). Fixed on branch `fix/BUG-111-pause-ends-call` off `main`, commit `47a44f3`,
> **unpushed**. Typecheck exit 0; full suite exit 0, 217 files, 2148 passed / 9 skipped
> — **+5 on the 2143 baseline, matching the five tests added**, which is how I know they ran.
> Both halves of the fix red-checked independently, each reversion verified as actually
> applied to the file before the run was interpreted (species 20).
> **Not** verified in a running Electron app — static + unit-test proof of the mechanism only.

Pressing **Pause** during a call and coming back 15 seconds later **ends and saves
the call**, and the screen says the microphone was disconnected. No race, no unusual
hardware, no timing window — just a pause longer than ten seconds.

- `src/renderer/src/features/live/audio/recorder.ts:146` — `if (!paused) onChunk(event.data)`.
  Pause is **renderer-local only**; there is no pause IPC.
- `src/main/session-health/liveness.ts:90` — `if (sinceAudio >= HEALTH_TUNING.noAudioMs) return { state: 'capture-dead', ... }`
- `src/main/transcription.ts:632` — `if (live.state === 'capture-dead') emit(s, 'transcription:captureLost', ...)`
- `src/renderer/src/features/live/useTranscription.ts:477` — the handler calls
  `armSave()`, `recorder.stop()`, `transcription.stop()`, `setPhase('no-device')`.

Mechanism: with `paused` true, `onChunk` never fires → `sendAudio` is never called →
`liveness.onAudio()` never runs → `lastAudioMs` freezes. The 1 Hz health tick is never
cleared on pause. At `noAudioMs` (10 000 ms) the watchdog declares capture dead.
`liveness.setSending(false)` — which would signal "streaming deliberately paused" — is
called from exactly **one** place in the repo, `transcription.ts:1315` (the stop
handler), never from pause. And it would not have helped: `capture-dead` is the *first*
check inside `evaluate()`.

Why it survived: `liveness.ts:82` carries the comment *"Streaming paused (mic muted,
session stopping) — server silence is fine"*, so the file reads as though the pause case
is handled. It is handled for the socket-dead branch only. No test drives `togglePause`
through to main.

**Agent's own caveat:** did not verify the on-screen copy of the `no-device` state, nor
whether real users pause for >10 s often enough to have reported it.

**Refutation routes I checked and closed, in order:**
1. *Does `togglePause` send any IPC after all?* No — its entire body is `recorder.setPaused(next)` plus React state.
2. *Would `setSending(false)` have suppressed it?* No — `capture-dead` is evaluated **before** the `sending` guard, deliberately.
3. *Does silence-fill refresh the audio clock?* No — `lastAudioMs` has exactly two writers (`start`, `onAudio`), and the fill is tracked separately as `lastSilenceFillMs`.
4. *Is the health timer cleared on pause?* No — cleared only on stop paths (`:264`, `:1328`); it ticks straight through.
5. *Is there a second audio route that bypasses `sendAudio`?* No — `pump.ts:61` `fastPathEnabled()` returns `false`, hard-off.
6. *Does the renderer's `captureLost` handler check `paused`?* No — it arms the save, stops the recorder and drops to `'no-device'` unconditionally.
7. *Is `noAudioMs` actually 10 s?* Yes — `types.ts:89`, `noAudioMs: 10_000`.

**The sharpest corroboration** is four lines *below* the bug. `transcription.ts:636-638`
reads: *"Deepgram closes with 1011/NET-0001 if no audio arrives within ~10s... A muted or
paused call must therefore keep sending real silence."* The author was thinking about pause,
wrote the silence-fill for it — and the unguarded `capture-dead` emit sits immediately above.

**A hole in my own fix, found while writing it and closed:** `transcription.ts:575`'s
sleep-recovery path calls `liveness.start()` on a session that is **still live**, which cleared
the flag and would have re-armed capture-dead against a still-paused renderer — the same bug,
one lid-close removed. Carried across explicitly, with its own test.

**What the fix un-shields (species 24, applied to my own change):** the old behaviour also
happened to end calls orphaned *while paused* by a renderer reload. That was a side effect of a
bug, not a safety net, and a renderer **crash** is still caught independently by
`render-process-gone` (`transcription.ts:1079`). The orphaned-live-call case is §4's open
question, which I deliberately left without a severity.

### CAL-1 — Every calendar sync failure is invisible, and the code's justification for that is false
**Severity: CRITICAL · Field-critical: yes · Confidence: high**

A rep creates a meeting in CallRise with two-way sync on. The push fails (403, dead
token, Graph 500). The event sits happily in the CallRise calendar. It is **not** on
their Google/Outlook calendar, not on their phone, and no reminder will fire. There is
no toast, no badge, no icon, no Activity Center row.

- `src/main/events.ts:186-194` argues explicitly against making the push a job because
  *"a failure already surfaces ON THE EVENT ITSELF in the Calendar UI via sync.state"*.
- `grep -rn "lastError" src/renderer/` → **one hit**, the type declaration at
  `src/renderer/src/features/calendar/types.ts:25`. `MonthGrid.tsx` and `WeekGrid.tsx`
  contain no reference to `sync` at all. **Nothing in the renderer ever reads it.**

The claimed surface was never built. This is the confident-justification-citing-a-
guarantee-that-does-not-exist shape (taxonomy species 26), on a data-loss path.

### CAL-4 — `remoteUpdatedAt` is written six ways and never read: remote calendar edits are never pulled, and local edits silently overwrite them
**Severity: CRITICAL · Field-critical: yes · Confidence: high that no comparison exists in `src/`**

The customer moves a meeting 2 pm → 4 pm in Google. CallRise keeps showing 2 pm
permanently. Then any local edit pushes the **stale** 2 pm back, silently overwriting
the customer's reschedule.

- `src/main/events-fs.ts:38-41` documents `remoteUpdatedAt` as *"the echo-loop watermark
  (M14 step D)"*.
- Every reference across `src/` is an assignment, a type declaration, a sanitizer
  passthrough, or a payload field. **There is no comparison anywhere.**
  `grep -rn "echo-loop\|watermark\|applyRemote\|mergeRemote\|remoteWins" src/` finds only
  the doc comments themselves.
- `buildItems` (`src/renderer/src/features/calendar/items.ts:78-101`) drops the pulled
  copy when a local link matches, so the screen renders only the never-updated local record.

Self-inconsistency worth noting: `calendar-match.ts` / speaker identity read
`getCachedGoogleEvents()`, which holds the **correct** 4 pm — so the calendar screen and
speaker identity disagree about the same meeting.

**Agent's own caveat:** found no doc saying "M14 step D was deferred", so it is unclear
whether this is a known accepted gap or a real regression.

---

### CONSENT-1 / BUG-115 — the Radar Report kept the buyer's verbatim words after consent was revoked
**Severity: CRITICAL · Field-critical: yes · ✅ CONFIRMED and FIXED (`59937f5`)**

The single most important finding of the night, and the one the missing consent pass was for.

`LiveView.tsx:133-136` — the gated and ungated calls are adjacent:
```
clips.flush(callId)                              // -> addBookmark -> applyConsentRetention
void window.api.calls.saveDealIntelligence(...)  // no gate at all
```
`setCallDealIntelligence` (`calls-fs.ts`) never re-applied retention, unlike `addBookmark`
since BUG-028. And `applyConsentRetention` is an ALLOWLIST — `speakerIdentities`, `bookmarks`,
`segments`/`preview`/`speakerCount` — that `dealIntelligence` (M24, later) never joined.

The payload is the buyer's own speech: `evidenceQuote` up to 400 chars, `evidenceRole:'other'`,
and deal-tier1's prompt demands *"the exact quote, word for word ... Never paraphrase or
invent it"*. Up to 200 per call, rendered back at `RadarReport.tsx:156`.

**This is BUG-014 -> BUG-028's shape a THIRD time**, two statements from the second fix.

The red-check printed the leak in full — `"evidenceQuote": "<buyer words>"` with
`"evidenceRole": "other"` next to `"recordOtherParty": false` in the raw file.

**Left open deliberately:** applyConsentRetention is still an allowlist over a Call shape that
has outgrown it (`summary`, `coaching.evidence`, `commitments`, `coachChat`, `notes`
unexamined). Only `dealIntelligence` is reachable with unconsented content today, and that is
a property of the current call graph, not of the guard. `deleteCall`'s tombstone solves the
same problem the safe way — a closed literal of what survives. Inverting it is a design
change, not a bug fix.

---

## 2. RANKED FINDINGS

Severity is the reporting agent's, adjusted only where its own text argued for a
different number. **"Verified" column is honest: nothing got a second pass.**

| # | Finding | Sev | Field-crit | Area | Verified? |
|---|---|---|---|---|---|
| LIVE-1 | Pause >10 s ends the call ("mic disconnected") | CRIT | yes | live | ✅ **CONFIRMED + FIXED** (`47a44f3`) |
| CAL-1 | All calendar sync failures invisible; justification cites a UI that doesn't exist | CRIT | yes | calendar | ❌ single pass |
| CAL-4 | `remoteUpdatedAt` never compared → remote edits never pulled, local edits overwrite them | CRIT | yes | calendar | ❌ single pass |
| JOBS-1 | "Regenerate" orphans the prior draft; the **stale** one wins on every reopen, permanently unprunable | CRIT | yes | jobs | ✅ **CONFIRMED + FIXED** (`98fb4be`) — stale-draft half only |
| LIVE-2 | `endCall({saved:true})` ends whatever call is *current*, not the one saved → next call lost in full | HIGH | yes | live | ❌ single pass |
| CAL-2 | Reminders silently dropped when set on a Google/Outlook event, while UI promises a push notification | HIGH | yes | calendar | ❌ single pass |
| CAL-5 | Event deleted in Google is silently **re-created** by the next local edit | HIGH | yes | calendar | ❌ single pass |
| CAL-6 | User edit racing a background sync write is silently lost — lock exists, `updateEvent` isn't under it | HIGH | yes | calendar | ❌ single pass |
| CAL-7 | Outlook all-day events shift a day east of UTC — a UTC string slice the sibling module explicitly bans | HIGH | yes | calendar | ❌ single pass |
| CAL-3 | Deleting a Google/Outlook event closes as if it worked when main refused | HIGH | yes | calendar | ❌ single pass |
| JOBS-4 | Quit-time final write is fire-and-forget across process exit → lost job state, `.tmp` orphans forever | HIGH | yes | jobs | ❌ refuter died |
| JOBS-5 | The recurring `JobManager` ENOENT is **not** an unrelated flake — `dispose()`'s documented guarantee does not exist | HIGH | (test) | jobs | ❌ refuter died |
| JOBS-2 | A throw in `finishSuccess`'s notify chain re-classifies a SUCCEEDED job as FAILED, stripping retention protection | HIGH | yes | jobs | ❌ refuter died |
| JOBS-6 | Scheduler stamps "it ran" before running; one throw kills the whole tick and escapes uncaught | HIGH | no | jobs | ❌ refuter died |
| JOBS-3 | Cancel on a `worker` job leaves it "Running" forever and burns a lane slot (no `exit` handler) | HIGH* | no | jobs | ❌ refuter died |
| CAL-14 | "Connected · Two-way sync on" survives token revocation forever; events retry silently forever | MED-HI | yes | calendar | ❌ single pass |
| SET-1 | `app-settings` load/merge are closed literals with **no spread** → any newer field is erased on next save | HIGH | yes | settings | ❌ partial agent |
| SET-2 | A failed settings write is silently swallowed by nearly every renderer call site (incl. `syncScope`, a privacy toggle) | HIGH | yes | settings | ❌ partial agent |
| CAL-9 | Non-retryable remote delete silently **resurrects** an event, and bumps `updatedAt` so it propagates to every device | MED | yes | calendar | ❌ single pass |
| CAL-8 | Same "Regenerate" defect as JOBS-1, independently found from the tasks side | HIGH | yes | tasks | ✅ same fix (`98fb4be`) |
| LIVE-4 | Mic test can kill, or silently hijack, a live call's Tier 1 engine (wrong-mic audio into the transcript) | MED | yes | tier1 | ❌ single pass |
| JOBS-7 | Partial task save + reopen re-proposes already-saved tasks → duplicates | MED | yes | jobs | ❌ refuter died |
| LIVE-3 | Mic test during a call detaches the PCM buffer out from under the recorder, then tells the user to file a support ticket | MED | no | tier1 | ⚠️ agent flagged a 5-min runtime check that would collapse it |
| LIVE-5 | "Test my microphone" tests the **system default** mic, not the one the app records from | MED | no | tier1 | ❌ single pass |
| LIVE-6 | Auto-stop says "Call saved" on the exact case where nothing is saved | MED | no | live | ❌ single pass |
| LIVE-7 | Slow engine start strands `denoisingActive: null` → Tier 1 silently never engages, card says "Connecting…" forever | MED | no | tier1 | ❌ single pass |
| CAL-11 | Editing a Google/Outlook meeting strips its attendee list from the prep brief | MED | no | calendar | ❌ single pass |
| CAL-10 | Google 409 recovery adopts a possibly-**cancelled** event, then reports "synced" | MED | no | calendar | ❌ single pass |
| JOBS-8 | Cancelled jobs are invisible in every UI group, defeating the reason retention keeps them | MED | no | jobs | ❌ refuter died |
| JOBS-9 | Embeddings warm-up re-runs + toasts **every launch**, announcing setup that isn't happening | MED | no | jobs | ❌ refuter died |
| JOBS-10 | Concurrent `writeJsonAtomic` to one path has no ordering guarantee — an older snapshot can land last | MED | yes | jobs | ❌ refuter died |
| JOBS-11 | Retention is bounded by COUNT only; no size/age bound and the protected set is unbounded | MED | no | jobs | ❌ refuter died |
| CAL-12 | `GenerateTasksDialog` unmount mid-save partially persists then duplicates; rep's own edits live only in component state | MED | no | tasks | ❌ single pass |
| LIVE-10 | `endCall`'s `saveInFlight` early return skips the 1.2.6 consent clear (near-miss, not a live leak today) | LOW | no | consent | ❌ single pass |
| LIVE-11 | `redactJournalConsentIfNeeded` truncates a journal at the first mid-file corrupt line | LOW | no | consent | ❌ single pass |
| CAL-13 | A cancelled/interrupted "Generate tasks" renders as "Claude didn't find any action items" | LOW | no | tasks | ❌ single pass |
| JOBS-12 | Finished download renders "100 / 100" — closed-literal rebuild drops `unit: 'percent'` | LOW | no | jobs | ❌ refuter died |
| JOBS-13 | `handle.checkpoint()` writes to a job in ANY state, including terminal ones | LOW | no | jobs | ❌ refuter died |
| JOBS-14 | `cancel()` on a queued job ignores `cancellable`, contradicting the BUG-060 contract at the IPC boundary | LOW | no | jobs | ❌ refuter died |
| JOBS-15 | Toast stack has no depth cap | LOW | no | jobs | ❌ refuter died |
| LIVE-8 | `denoised-source.js`'s `stop`/`stats` messages are dead — nothing ever sends either | LOW | no | tier1 | ❌ single pass |
| LIVE-9 | `denoised-source.js` header states as fact that nothing imports it; `recorder.ts:4` does | LOW | no | docs | ✅ trivially checkable |
| OWN-2 | Nine hand-duplicated copies of one per-id write lock; the shared helper already exists at `events.ts:51` | MED | no | main | ✅ I diffed all nine |
| OWN-3 | ErrorBoundary's only recovery is a full reload, and its copy claims data safety it never checks | MED | ? | renderer | ⚠️ see §4 |
| OWN-4 | `verify:runner` silently overwrites the suite's own captured `test-output.log` | LOW | no | tooling | ✅ hit it myself |

\* JOBS-3: the agent conceded only `dev:fakeCpu` uses `kind:'worker'` and it is `is.dev`-gated.
**If that holds, this is a latent + documentation defect, not a shipping bug.** The refuter
was specifically tasked with settling that and died first. Treat HIGH as unconfirmed.

---

### JOBS-1 / CAL-8 — "Regenerate" showed the draft the rep had just rejected
**Severity: CRITICAL · Field-critical: yes · ✅ CONFIRMED and FIXED (`98fb4be`)**

Found independently by two auditors, then verified by me. `JobManager.list()` walks
`this.order`, which is **push-only** (`:157`, `:253`, with only filter-removals at `:343`
and `:686`) — so it is oldest-first, and `.find()` over it returns the OLDEST match.
Neither the main-side dedupe (`tasks.ts:182`, `crm-note-generator-ipc.ts:148` — verified by
grep to be the only two that can match a `succeeded` job, i.e. the two `retainUntilConsumed`
types) nor the screen's adopt-on-mount (`useJobByTarget.ts:74`) sorts or prefers newest.

`tasks.ts:176-181`'s comment reasons carefully about *whether* a succeeded job should count
as "already there" — and never about *which one*. That is the whole bug.

**Fix:** `JobManager.findLatest(predicate)` scans backwards, and the three call sites use it.
The ordering knowledge now lives where `this.order` lives, so no caller has to know that
`.find()` means "oldest" — which was the actual defect, since `.find()` reads as "the one".

**Red-checked at two levels**, each reversion verified as applied first: the helper (forward
scan → its unit test fails), and **separately** the renderer call site (reverted to the
original `.find()` → `expected 'before-regenerate' to be 'after-regenerate'`, the bug
reproduced through the hook the dialog really mounts). The second check exists because a
helper test cannot see whether a call site scans the right way — species 21.

**Deliberately left unfixed:** the orphaned job still accumulates in "Needs your review", is
exempt from pruning (`retention.ts` `isProtected`), and cannot be dismissed without a
`consumed` flag the UI never sends. Separate MEDIUM — clearing it would DELETE a draft, which
is a different call from "show the newest one".

---

## 3. THE MECHANICAL CENSUSES (these I ran myself, and red-checked)

### 3.1 Type duplication — 34 hand-written types have already drifted

Instrument: AST census using the TypeScript 5.9.3 parser (not grep) over 459 non-test
source files. Script and full report are in this session's scratchpad.

**The instrument was red-checked and found wrong on its first run.** It reported 70
drifts. Opening the first file it accused —
`src/renderer/src/features/settings/useAppSettings.ts:3`,
`export type AppSettings = Awaited<ReturnType<typeof window.api.settings.get>>` — showed a
**derived** type that cannot drift by construction. 36 of the 70 were that false-positive
class. Corrected result:

| | count |
|---|---|
| type names declared in >1 file | 193 |
| identical across all hand-written declarations | 159 |
| **genuinely drifted** | **34** |
| names already using the derived pattern (cannot drift) | 101 |

That last row matters: **the codebase mostly does this correctly already.** The 34 are
outliers, so converting them is an idiomatic small change, not a refactor.

Highest-stakes rows (each re-verified by independent grep, not just by the tool):

- `Call.deleted` — only in `src/main/calls-fs.ts:504`. Absent from preload and renderer.
- `Deal.deleted` — only in `src/main/deals-fs.ts:35`. `Task.deleted` — only in `src/main/tasks-fs.ts:46`.
- `CallBase.salesBrainExcluded` — only in main. The renderer's type cannot see "don't learn from this call".
- `CallSummary.talkRatio` / `.questionCount` — only in main.
- `Contact` — main 37 members, preload 14, renderer 36.
- `Deal.stageHistory` / `.riskAssessmentHistory` — in main + renderer, absent from preload.

**Tombstone sub-finding — chased specifically, and CLEAN.** I pursued `deleted` because
BUG-017 ("deleted calls silently resurrect") is exactly this shape. It does **not**
reproduce: `tasks-fs.ts:174` and `deals-fs.ts:226` both carry
`deleted: v.deleted === true ? true : undefined // preserve the tombstone flag` inside the
normalizer, and `updateTaskUnlocked` mutates in place rather than rebuilding, while
`getTask` returns null for a tombstone. Reporting the clean result explicitly, because
this is the shape most likely to be *assumed* broken.

### 3.2 Nine copies of one write lock (OWN-2)

`tasks-fs.ts:251` · `contacts-fs.ts:428` · `deals-fs.ts:360` · `knowledge-fs.ts:201` ·
`events.ts:51` · `calls-fs.ts:1366` · `contact-intelligence-ipc.ts:73` · `google.ts:339` ·
`outlook.ts:387`.

I diffed all nine. Two variants; **both are correct today. This is not a live bug.** It is
BUG-023's shape pre-loaded — nine copies means a future fix lands in one. The comments say
so out loud (`tasks-fs.ts:248`: *"Deliberately duplicated from events.ts"*), and
`events.ts:51` **already generalised it** to `serialize(map, id, fn)` — a shared helper that
exists and is not used by the six files that need it.

⚠️ **CAL-6 above says this is already biting.** `updateEvent` is under *neither* of
`events.ts`'s two chains. So the "both correct" verdict is about the nine implementations,
not about their coverage.

---

## 4. THE ONE I COULD NOT SETTLE — flagged doubt, not a claim

**OWN-3 — ErrorBoundary reload during a live call.** I found the pieces but could not
close it, and I would rather hand over the open question than a severity I can't defend.

Established:
- `src/renderer/src/components/ErrorBoundary.tsx:44` — the only recovery is
  `window.location.reload()`.
- `:39` — the copy says *"Your data is safe — reload to pick back up."*, unconditionally.
- `src/renderer/src/app/App.tsx:66` — ErrorBoundary sits **inside** `LiveCallProvider`,
  deliberately (comment at `:56-64`) so an unrelated render crash cannot tear down a live
  call. **The reload button undoes exactly that protection.**
- Audio capture is renderer-side: `recorder.ts:114` `getUserMedia`.
- `grep -rn "beforeunload" src/` → **zero hits app-wide.**
- `src/main/live/live-transcript-ipc.ts:50` `listRecoverableCalls()` sweeps on demand —
  but `:58-59` `const liveId = liveCallInfo()?.callId` / `if (orphan.id === liveId) continue`
  **deliberately excludes the call main still considers live.** A renderer reload does not
  restart main, so main still thinks the call is live and the recovery prompt will skip it.

**Not established:** whether `LiveCallProvider` re-attaches on load, whether it
re-acquires the mic or only restores UI state, and what the session-health timeout does
with a call whose audio stopped. I sent this exact question to the live-call agent; it
answered the Tier 1 half (see below) but the reload question was not in its returned
report. **Unresolved. Do not assign a severity without tracing it.**

---

## 5. NOTABLE *CLEAN* RESULTS — things checked and found sound

Recording these deliberately: an audit that only lists defects gives a false picture, and
several of these are load-bearing guarantees somebody will otherwise re-audit.

- **The Tier 1 raw-mic property HOLDS.** The headline risk in
  `docs/M27-tier1-recorder-handoff.md` — that Tier 1 could cost a *recorded call* by
  stopping the mic — was chased specifically. The mic track is never stopped on the Tier 1
  path, `micSource → analyser` survives (only the targeted 3-arg `disconnect(merger, 0, 0)`
  is used), `useRawSource()` is idempotent, and `stop()` nulls `worklet.port.onmessage`
  before anything that can throw. `recorder.tier1.test.ts` asserts this with spies rather
  than inferring it. **No path found where Tier 1 costs a recorded call.**
- **Tier 1 wiring is landed and live.** `recorder.ts:4` imports `denoised-source.js` and
  `:245` calls `addModule`. `docs/M27-tier1-recorder-handoff.md`'s "nothing calls it" is
  **stale on current main** — the wiring landed; only the comment didn't get updated (LIVE-9).
- **Interrupted-call recovery is wired end to end** and *is* read back at startup;
  `replayJournal` reaches disk with consent, duration, gaps and rep attribution intact,
  and `markJournalRecoveredAsCall` closes the double-Call window. The one thing that
  breaks it is LIVE-2 marking the *wrong* journal `.done`.
- **`transcript-accumulator.ts` epoch handling is correct on every path** and matches the
  frozen `segments.ts` oracle line for line (taxonomy species 12 checked; the duplication
  is real but the copies agree today).
- **`loopback.ts`'s consent gate is genuinely bound to `callId`** at both arm and grant,
  re-read fresh at grant. This is what makes LIVE-10 a near-miss rather than a leak.
- **`applyConsentRetention` runs on save AND read AND list**, and `addBookmark` re-applies
  it before writing (BUG-028's fix holds). `isOtherPartySpeaker` correctly refuses to strip
  on `channel === undefined`.
- **Cancellation genuinely reaches the work** in `generateTasks` and `extractCommitments`
  (`handle.signal` → `completeWithFallback`).
- **The test runner discriminates.** `npm run verify:runner` passed on this machine
  tonight: a stray unhandled error produces a non-zero exit AND its text is captured.
  So the baseline "exit 0" below is a signal that has been seen to go red.
- **The settings upgrade path IS covered** by a real test with real temp files and a real
  `vi.resetModules()` restart (`app-settings-auto-update-migration.test.ts:41`).
  It is *unknown extra fields* that are uncovered (SET-1).

---

## 6. BASELINE, AND HONEST COVERAGE

### Baseline (established before anything, exit codes read directly, nothing appended)
- `npm run typecheck` → **exit 0**
- `npm test` (`scripts/run-tests.mjs`) → **exit 0** · 217 files · 2143 passed / 9 skipped (2152)
- `test-output.log` scanned for stray-error lines (species 4) → **none**
- `npm run verify:runner` → **OK**

### What actually got audited

| Area | Status |
|---|---|
| Live calls, transcription, recorder, Tier 1, session health | ✅ complete |
| Jobs, scheduler, notifications | ✅ complete |
| Tasks, calendar, events, Google/Outlook sync | ✅ complete |
| Test integrity: consent + calls + jobs suites | ✅ complete |
| Test integrity: contacts + deals + tasks + coaching suites | ✅ complete |
| Product/UX review of the renderer | ✅ complete |
| Settings/updater test integrity + preload contract count | ⚠️ substantial partial |
| **Consent + privacy invariants (dedicated pass)** | ❌ **died at startup — biggest gap** |
| Preload/renderer/main IPC contract drift | ❌ died mid-flight (had found an escape hatch) |
| Coaching, knowledge, analytics, objection library | ❌ died mid-flight |
| Updater, packaging, native modules, detection | ❌ died mid-flight |
| Settings/onboarding/auth (defect pass) | ❌ died mid-flight |
| Dead code + type safety | ❌ died mid-flight |
| Whole-suite hollow-test sweep | ❌ died mid-flight |
| **Adversarial verification of all of the above** | ❌ **never ran** |

**The consent gap is the one that matters most.** Consent invariants are sacred here and
BUG-014/BUG-028 already showed this area produces "fixed one path, missed the second".
The dedicated enumeration — *every* path by which the other party's words reach durable
storage — was never built. The incidental consent results in §5 are reassuring but are
**not** that enumeration.

---

## 7. TEST-INTEGRITY FINDINGS (hollow greens found in the existing suite)

These are guarantees the suite currently reports as covered and does not cover.

| # | Test | What breaks while it stays green |
|---|---|---|
| T1 | `loopback-consent-binding.test.ts:250` — "BINDS a grant to its call" | **Never starts a second call.** "Call B" is still call A. Revert the M27 `consentPermitsCapture(live.callId)` binding at `loopback.ts:146`/`:185` and it stays green. |
| T2 | `activity.test.ts:46` — "never fires a started event during a live call" | Uses a **queued** job, so the `if (!liveActive)` guard at `activity.ts:96` is never reached. Delete the guard → still green → toasts fire mid-call. |
| T3 | `activity.test.ts:80` — silent-job start suppression | Same queued-job defect. Delete `activity.ts:80` → still green. |
| T4 | `capacityDeferral.test.ts:214` — "flags nothing while capacity is available" | Decided by lane occupancy, not capacity. Delete the capacity check in `deferredJobIds()` and **all four** tests in the describe stay green. |
| T5 | `consent:persist`'s journal copy (`loopback.ts:104` `recordConsent`) | **No test drives it through the handler.** Delete the line → every in-scope test passes → a crash-recovered buyer-capture call loses the buyer's entire half at the moment of rescue. |
| T6 | 6× cancellation tests (`summarize-`, `coach-`, `commitments-`, `contact-intelligence-`, `crm-note-`, `mine-…`) | **Cooperative doubles**: the fake performs the abort itself. Real provider → real SDK has **zero** coverage. Delete `signal: req.signal` from any of 7 provider call sites → full suite green → Cancel is cosmetic again (BUG-060 returns). |
| T7 | Same 6 tests | **None asserts the result was not persisted.** Remove `if (!result.ok) return` at `calls.ts:244` → a cancelled job writes an AI comment, triggers a backup, and stamps `crmNoteGeneratedAt` so it can never be regenerated → all six still pass. |
| T8 | `settings-nav.alerts-hidden.test.ts:24` | Vacuous quantifier — proven by mutation: deleting the entire `AI & coaching` group (8 real settings pages) leaves all nine assertions green. |
| T9 | `consent-gate.test.ts:175` + `live-engine-consent-gate.test.ts:168/270/354` | Four tests named "survives a mid-call session restart" contain **no restart**, and the cross-file citation points at the wrong file. (The restart *is* genuinely covered — in `consent-lifetime.test.ts:206`.) |
| T10 | `consent-gate.test.ts:158` | Pins the **un-scoped** `consentPermitsCapture()` as permissive. No production caller uses it. This test protects the pre-M27 hole and would turn red if someone hardened it to fail closed. |
| T11 | `GenerateTasksDialog.recovery.test.ts:250` | `expect(createCalls).toHaveLength(1)` — the payload is `unknown[]` and never inspected. Empty title, dropped edits, wrong priority all pass. |
| T12 | `skill-graph.test.ts:36` — "produces all 8 skills" | Never asserts 8. `Object.keys(scores)` is derived from the return value, so dropping a skill yields 7 and passes. |
| T13 | `CrmNoteGeneratorCard.recovery.test.ts:56` | The double **re-implements** main's `recordDecision`, so the assertion proves the test's own helper works. Already diverges from the real handler's `if (contact)` gate. |
| T14 | `capacityDeferral.test.ts:82,95` | `for…of idsForProvider('groq')` with no non-empty guard (the sibling test at `:57` guards exactly this). |
| T15 | `focus-skill.test.ts:120` | `not.toThrow()` as the only assertion; a blank coaching reminder could be written to disk and shown to the rep. |

**Zero test coverage** found for: the `worker` executor kind · the `Scheduler` class ·
`registerJobsIpc` · `src/renderer/src/features/onboarding/` · `src/preload/index.ts` (no
test imports it at all; the nine apparent hits are `import type` of the `.d.ts`, erased at
compile time).

**Latent trap:** `vitest.config.ts:16` uses `include: ['src/**/*.test.ts']`. No `.test.tsx`
exists today, so nothing is silently skipped — but **the first one added will never run and
never report.**

**Contract count (from the partial preload agent, worth keeping):** 203 `ipcRenderer.invoke`
channels ↔ 203 `ipcMain.handle` — 0 orphans. 32 preload subscriptions ↔ 32 main broadcasts.
Currently exact, held **purely by developer discipline**: every channel is a bare string
literal in two files with no shared constant. A renamed `broadcast()` channel produces a
listener that never fires, with **no error at all**.

---

## 8. PRODUCT / UX IMPROVEMENTS (from the "find improvements" pass)

Ranked by weekly pain for a working salesperson. None implemented.

1. **Three of four deletes fire a RED error toast for a successful delete.**
   `TasksView.tsx:85`, `PastCallsView.tsx:157`, `DealsView.tsx:274` all call
   `toast.error('… deleted')`, which `ToastProvider.tsx:14-21` renders with a warning
   triangle and `role="alert"`. `useContacts.ts:83` gets it right with `toast.success`.
2. **Enter doesn't submit in 4 of 5 entity dialogs.** Only `TaskFormDialog.tsx:85` uses a
   real `<form onSubmit>`. Contact and Deal — the two most frequent CRM actions — need the mouse.
3. **One-click irreversible deletes on hand-authored content, no confirm and no undo:**
   custom trackers (`CoachingSection.tsx:117`, which also swallows the failure), objection
   Reject (`ReviewQueueView.tsx:99`), contact comments (`ContactDetail.tsx:315`), call
   bookmarks (`CallDetail.tsx:1024`), API key Remove (`ApiKeysSection.tsx:336` — silently
   disables every AI feature). **The 6-second undo pattern already exists** at `useTasks.ts:30`.
4. **Same action, opposite safety models:** deleting a call from the list has no confirm but
   6 s undo (`PastCallsView.tsx:154`); from the detail page it has a two-step confirm and
   **no undo** (`CallDetail.tsx:800`).
5. **The disabled noise-cancellation toggle won't say why** (`CopilotPanel.tsx:99`).
   `DealsView.tsx:196` already has the right pattern (`title={… ? 'Add a contact first' : undefined}`)
   and is the only place in the codebase that does it.
6. **Bare grey rectangles on the two longest LLM waits** — deal risk
   (`RiskAssessmentCard.tsx:215`) and commitments (`CallDetail.tsx:1090`). Every sibling
   feature has an explanatory line; these don't.
7. **Memory Center shows conclusions and hides the evidence.** `Memory.evidence` carries
   `{callId, quote}` and `MemoryCenterSection.tsx:116-125` renders neither — for a feature
   whose stated purpose is transparency.
8. **Speaker-identity confidence is a 6px dot whose tooltip shows something else**
   (`SpeakerTranscript.tsx:192` — `title` shows `source`, never `confidence`). Those
   attributed quotes are what the coaching scorecard cites as evidence.
9. **The Undo button outlives its own window by 500 ms** — `UNDO_WINDOW_MS = 6000`
   (`useTasks.ts:30`) vs a 6500 ms toast (`ToastProvider.tsx:37`). Clicking in that gap
   flashes the row back, then loses it again.
10. **"All duplicates" is reported as a failure the rep can never fix**
    (`MineTestPanel.tsx:126`, reached on a genuine success where every candidate was already queued).

---

## 10. SECOND WAVE — the relaunched auditors (ALL UNVERIFIED unless marked)

Four of the dead auditors were relaunched when the usage window reset. One produced BUG-115
(§ above, verified and fixed). The other three returned large reports that **I did not have
capacity to verify**. They are recorded here as leads with the reporting agent's own
confidence, and every one of them needs the same treatment BUG-111/114/115 got before it is
believed. Where an agent stated its own limits, those are preserved.

### Packaging / updater / native — the area with the worst track record here

| # | Finding | Sev | Verified? |
|---|---|---|---|
| P-1 | **`extraResources` WARNS and continues when its source is missing** — `fileMatcher.js:266-275` logs `file source doesn't exist` and returns. Both platform blocks in `electron-builder.yml` claim it "fails the build" / "fails loudly". Latent on Windows (binaries committed); **present-tense on macOS**, where the source is a sibling checkout `../salesos-virtualmic` and there is no macOS CI at all → a silent no-denoiser `.dmg` | CRIT | ❌ |
| P-2 | **Nothing is disposed on the normal quit path.** `index.ts:597` `before-quit` only reaches the dispose block when `quitConfirmed` is already true; with no jobs running it sets the flag and returns, and `before-quit` is not re-emitted. `disposeTier1()` is the only thing that kills `kern_bridge.exe` | HIGH | ❌ |
| P-3 | **`M18final.bundle` (1.19 MB) + `M18final.patch` (963 KB) appear to ship inside `app.asar`** — a git bundle of a full branch plus 39 commit patches, matched by no exclusion. Agent verified the matcher semantics from electron-builder's own source but **did not extract a built asar** | HIGH | ❌ |
| P-4 | Species 11 still true and **structurally permanent**: native addons are built for Electron's ABI (140) while vitest runs under system Node (147), so `adapterContract.test.ts`'s win32 block can never load the addon — green, unskipped, on the very CI that ships the installer | HIGH | ❌ |
| P-5 | `kern_bridge.exe` spawned with no `'error'` handler, unlike the macOS sibling it says it mirrors. Nothing is code-signed, so AV/SmartScreen blocking is the realistic trigger | MED-HI | ❌ |
| P-6 | `tier1.ts:189-193` states kern_bridge does NOT look beside its own binary for the model; `electron-builder.yml:109-113` says it does. Agent extracted strings from the committed binary and found the bare-filename probe — **`tier1.ts` is stale**, and it is the premise for shipping the model at all | MED | ❌ |
| P-7 | The declared `arm64` Windows NSIS target ships three dead native subsystems and x64 VC runtimes. CI is scoped `--x64` so the published channel is safe; `npm run build:win` locally is not | HIGH* | ❌ |
| P-8 | The updater's "even in auto mode" test runs in **manual** mode (file-scoped mock pins it false), so the auto-download path — the one that installs software without a click, now ON by default — has **zero** coverage | MED | ❌ |
| P-9 | A cloud settings pull can re-enable an explicit auto-update "off". `syncScope` is deliberately protected per-device on exactly this reasoning; the same argument is not applied to installing software. CROSS-BOUNDARY (`backup.ts`, M29) | MED | ❌ |

**Manual steps with NO repo-side evidence they were ever done** (species 23): Windows code-signing, macOS notarization, **the Google OAuth consent screen still being in Testing** (which expires refresh tokens every 7 days → calendar sync dies weekly), four Supabase SQL files, four edge functions, Supabase secrets, the `pg_cron` job, and RLS verified against the live DB. Most are CROSS-BOUNDARY (M29) but the OAuth one is squarely in the calendar area and compounds CAL-1/CAL-14.

### Detection

| # | Finding | Sev | Verified? |
|---|---|---|---|
| D-1 | macOS **legacy** mic fallback cannot attribute mic use to a process, so it broadcasts a `mic-session` signal to EVERY running conferencing app. Dictation, Siri, or a personal call with Zoom+Teams+Slack open can cross the start threshold and silently record the rep's own mic into a saved call | CRIT | ❌ |
| D-2 | Pausing/disabling detection **while capturing** freezes the FSM in `capturing` and clears the tick timer, so nothing ever notices the call ended → the renderer never gets `requestStopCapture` and the mic/Deepgram session stays open. The same fix was applied to the window-closed path and never to pause | CRIT | ❌ |
| D-3 | The snooze timer is never cleared by `pauseDetection`/`resumeDetection`, so a stale timer can silently re-enable detection later — including after the master Settings toggle was turned off, with the tray already torn down so there is no visible way to stop it | CRIT/HIGH | ❌ |
| D-4 | `isSupported()`/`loadError` is a real guard with **no production caller** — the promised `detection:unavailable` channel does not exist. A failed native load looks identical to "no call right now", forever. Linux gets `NullAdapter` whose `isSupported()` is hardcoded `true` for test convenience | HIGH | ❌ |
| D-5 | Per-app "never" is unreachable for 11 of 29 known calling apps (Signal, Telegram, Viber, Cisco Jabber, …) because two app lists were never reconciled; the global policy has no "never" to fall back on | MED | ❌ |

**Recorded clean by that agent:** BUG-026/027's fixes are real and genuinely covered; the
fusion/policy/state-machine layer is well defended against the textbook misfires (a video tab
tops out below threshold; a lone unknown-app mic session is capped); tray/overlay lifecycle
has no leak; `loopback.ts` has no new bugs.

### IPC / preload security
Delivered the escape hatch (fixed, `732687a`). Also reported and **not verified**: the
`detection:state-changed` payload is declared non-optional but main can send `{state:
undefined}`, and the renderer dereferences it without the guard its sibling line uses — traced
as not currently reachable; three declarations hide an `error` field main returns.
**Recorded clean:** 203 invoke channels ↔ 203 handlers, zero orphans; **zero** leaked event
subscriptions across 44 sites; no boolean-vs-object lies; no renderer-supplied path or URL
reaches the filesystem or `shell.openExternal`; `will-navigate` and `setWindowOpenHandler` are
both solid.

---

## 9. HANDOFF — what the next session should do, in order

1. **Re-run the adversarial pass before fixing anything.** That is the step that was
   missed, and it is the step this project's own taxonomy says matters most. Order:
   LIVE-1, CAL-1, CAL-4, JOBS-1, LIVE-2.
2. **Then run the consent + privacy enumeration that never happened.** Build the list of
   every path by which the other party's words reach durable storage, from grep, and check
   each against the gate. Do not accept any comment or doc claiming "every path".
3. **Then the four other dead agents:** IPC contract drift (it had found an escape hatch
   and died before reporting it — re-run it first of the four), coaching/knowledge/
   analytics, updater/packaging/native, dead code.
4. **Fix order once verified:** field-critical on a separate branch off `main`, unpushed,
   flagged loudly. LIVE-1 is the best first fix — highest severity, no race needed, and
   the smallest surface.
5. **Do not fix without a red-check**, and **verify the reversion actually applied**
   before interpreting the result (species 20 — a red check that comes back green has two
   explanations and they look identical).

### Decision-gated — do NOT implement without the founder
- **CAL-4** — pulling remote calendar edits changes what data the app stores and which
  side wins a conflict. That is a product decision, not a bug fix.
- **CAL-1** — where and how a sync failure is surfaced is a UX decision.
- **JOBS-11** — adding a size/age bound to retention changes what gets deleted.
- **Any change to the 6 s undo window or the delete-confirm model** (§8 items 3, 4, 9).

### State of this branch
`claude/overnight-audit`, one commit, **this document only**. No source file modified.
`main` untouched. M28's and M29's files untouched — no finding above edits anything under
`src/main/assistant/`, `src/main/ai/`, `src/main/memory/`, `coaching-chat*`, `telemetry/`,
`entitlements/`, `backup.ts`, or `supabase/`.

### Logged for the other sessions (found in passing, not mine to fix)
- **M28/M29 — for whoever owns contacts/deals:** `contacts-fs.ts:204` and `deals-fs.ts:109`
  both do `new Date(t).toISOString().slice(0, 10)` — the exact UTC-slice-of-a-date-only-value
  that `google-sync.ts:30-31` explicitly bans, and the same defect as CAL-7.
- **T6/T7 above touch `src/main/ai/providers/`** (M28 territory). The *tests* are in my
  scope; the seven provider call sites they fail to cover are not. Flagging, not touching.
