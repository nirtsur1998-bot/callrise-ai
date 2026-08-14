# M26 Phase 0 — Operation Inventory & Navigation Map

Status: Research complete, awaiting founder go-ahead before Phase 1
Repo/branch: `claude/m26-engine-room`, worktree `C:\Users\User\Desktop\callrise-m26`, branched off `main` @ `ff23d2c`
Researched by: 15 parallel deep-dive passes over the actual source (every claim below is a real file:line citation, not a guess)

---

## Read this first — the 4 things that actually matter

> 📌 **POINT-IN-TIME SNAPSHOT (2026-08-12), kept as a record — not current state.**
> *(Flagged by the M27 Phase 4 docs audit, 2026-08-14.)* Item 1 below describes
> the live-call data-loss bug as an active, unfixed emergency. **It was fixed
> four phases later and shipped in v1.2.0** — the transcript now lives in the
> main process with incremental journaling (`live/live-transcript.ts`,
> `live/call-journal.ts`), the capture session is hoisted above the navigation
> boundary in `LiveCallProvider.tsx`, and a dedicated crash test
> (`render-process-gone.test.ts`) proves the journal survives a renderer crash.
> This doc's status line already says "awaiting founder go-ahead before Phase
> 1", but nothing in it says the headline scenario was resolved — so a skim
> could still conclude the app is losing customer calls today. It is not.

**1. The scariest bug isn't "AI jobs die on navigation" — it's silent, total loss of the live call itself.**
Every screen switch (clicking any sidebar item, or opening/closing Settings) fully destroys and rebuilds the screen you're leaving — that's how this app's screen-switching works today, on every screen, always. For 10 of the 11 screens that's harmless: the real work happens in the background app process regardless, so you just don't see the "done!" checkmark until you go back and look. **Live Calls is the one screen where it's catastrophic**: the code that "stops everything when you leave" was written for the Stop button, and screen navigation accidentally triggers that exact same code path — except the Stop button also saves the call first, and plain navigation does not. Today, if you're on a live call and click Settings (or anything else) before pressing Stop, **the entire transcript, live coaching cues, and deal-intelligence read-out for that call are silently thrown away** — no save, no warning, nothing recoverable. This is the single most important thing Phase 4 needs to fix, and honestly the most urgent one — worth considering as a fast, standalone fix before the rest of M26 if you want to stop the bleeding sooner.

**2. Opening or leaving Settings is worse than any other navigation.** Every other screen switch only tears down that one screen. Settings is wired as a full replacement of the entire app shell (sidebar and all) — so it triggers the same "leaving a screen" teardown as any other click, but from a place you might not expect. This is why "I open Settings and my live call disappears" happens.

**3. One naming mismatch I need you to resolve.** Your brief lists "Import now" as an operation to migrate, describing it as importing/transcribing a call recording. **That feature doesn't exist anywhere in this codebase** — I searched exhaustively (file pickers, drag-drop, audio extensions, transcribe-from-file code, all main and renderer code). The only "Import now" button that actually exists is in Settings → Sales Brain, and it imports your existing contacts/deals/past-call text into the AI's memory system (M25) — no audio, no transcription. I need you to tell me which one you meant:
   - If you meant the Sales Brain import — good, it's in the table below (row 1), already inventoried.
   - If you actually want a "drop in a recording and get a transcript" feature — that's net-new functionality, not a migration, and would need its own scoping before Phase 3 could touch it.

**4. Good news: the hardest part of the live-call pipeline is already in the right place.** The Deepgram transcription connection (reconnect logic, lag/health tracking, all of it) already lives in the main app process, not tied to any screen — it doesn't need to be rearchitected. It's only being killed today because the "leaving a screen" cleanup code calls its stop function unconditionally. That's a targeted behavioral fix, not a rebuild. The two genuinely hard pieces are the live coaching-cue engine and the live deal-intelligence engine — both keep all their memory only in the screen's own code, with nothing backing them up in the main process, so making those survive navigation is real work (detailed in Phase 4 notes below).

---

## Full operation inventory

Legend for **Dies on nav?** — `No` = work finishes regardless of what you click; `Partial` = the work finishes and saves, but you never see the result unless you reopen it; `Yes` = the work itself is destroyed/lost.

| # | Operation | Triggered by | Runs today in | Dies on nav? | Progress shown today | Est. duration | Cancel today? | Recommended lane |
|---|---|---|---|---|---|---|---|---|
| 1 | Sales Brain "Import now" (backfill contacts/deals/calls into AI memory) | Settings → Sales Brain button | main, fire-and-forget | No | Real: stage + count, polled every 1s | Instant (contacts/deals) to minutes (calls, opt-in) | No | BATCH |
| 2 | Scan past calls (objection library) | Objection Library "Scan N past calls" button | main, inline loop in one IPC call | Partial | Fake spinner only (main tracks real counts internally, never sent to screen) | ~10s × number of eligible calls | No | BATCH |
| 3 | AI summary | Call detail "Summarize" button / auto-fire after live call | main, one blocking AI call | Partial | Fake spinner | Single AI call, few seconds–~1 min | No (but AI layer supports it — see below) | INTERACTIVE |
| 4 | Coach this call | Call detail "Coach" button | main, one blocking AI call | Partial | Fake spinner | Single AI call, few seconds+ | No (same as above) | INTERACTIVE |
| 5 | Coach chat (Ask Coach follow-up questions) | Coach report chat panel | main, **already streams** token-by-token | Partial (mid-stream messages vanish if you leave, but the final answer still saves) | Real streaming text — the one place in the app with true live progress | Seconds per turn | No | INTERACTIVE |
| 6 | Export coaching report as PDF | Coach report "Export PDF" button | main, opens save dialog + renders | No (self-contained, fast) | Fake spinner | Under ~2s | N/A (too fast to matter) | INTERACTIVE |
| 7 | Find commitments | Call detail "Find commitments" button | main, one blocking AI call | Partial (result IS saved even if you navigate away) | Fake spinner | 5–20s | No | INTERACTIVE |
| 8 | Generate tasks | Call detail "Generate tasks" dialog | main, one blocking AI call | **Yes** — nothing is saved until you click Save in the dialog, so closing early throws away real, already-paid-for AI output | Fake spinner | 5–20s | No | INTERACTIVE |
| 9 | Generate CRM note (contact page, manual) | Contact page "Generate note" button | main, two AI calls in parallel | Partial | Fake spinner | Few seconds–~20s | No | INTERACTIVE |
| 10 | Generate CRM note (automatic, after a call) | Fires by itself after any call is saved/summarized, if the setting is on | main, fully background, no screen involved | No | None (silent) | Few seconds–~20s | No | BATCH |
| 11 | Detect who this was / auto-attach contact | "Detect who this was" button, or automatic if "full-auto" mode is on | main, one AI call (+ contact creation if full-auto) | Partial (button) / No (auto mode — you get a native notification) | Fake spinner (button) / none (auto) | Few seconds | No | INTERACTIVE (button) / BATCH (auto) |
| 12 | Deal Tier 1 — live risk/opportunity nudges | Automatic during a live call, every ~5–20s | main, one small AI call per tick | **Yes, by design** — abandoned instantly if you leave the call screen | 3-state badge only | Deliberately capped at 4 seconds | Client-side only (server call still finishes wastefully) | **LIVE** |
| 13 | Deal Tier 2 — live deal health score | Automatic during a live call, every ~60–150s | main, one AI call per tick | **Yes, by design**, same as Tier 1 | 3-state badge only | Few seconds | Client-side only | **LIVE** |
| 14 | Deal risk assessment (manual, per-deal) | Deal detail "Assess risk" button | main, one AI call | Partial (result IS saved) | Fake spinner | Several seconds | No | INTERACTIVE |
| 15 | KYC harvest — apply suggestion (from Coach Chat or CRM Note card) | Clicking "apply" on a suggested fact | main, local write, no AI call (the AI already ran earlier) | No | Per-item spinner | Under 100ms | N/A | INTERACTIVE |
| 16 | Cloud backup (push) | Settings "Sync now" button, or automatic (on launch + every 10 min + after any local change) | main, sequential upload | No (already survives navigation and even app reload) | Boolean "Syncing…" only, no percent | Seconds to tens of seconds, scales with data | No | **MAINTENANCE** (per your own spec) |
| 17 | Cloud restore (pull) | Same "Sync now" button (always bundled with backup — no separate restore trigger exists today), or automatic on sign-in | main, sequential download | No | Same boolean as backup — **can't currently tell the two apart in the UI** | Seconds to much longer on a brand-new machine | No | MAINTENANCE |
| 18 | Sync Google Calendar | Calendar screen, on open or toggle | main, one API call | Partial | Boolean spinner | 1–5s, more with many calendars | No | INTERACTIVE |
| 19 | Sync Outlook Calendar | Calendar screen, on open or toggle | main, one API call | Partial | Boolean spinner | 1–5s | No | INTERACTIVE |
| 20 | Push a calendar event to Google/Outlook | Creating/editing/deleting an event | main, already fully background | No | None | ~0.1–2s per event | Implicitly (a later edit supersedes an earlier queued push) | BATCH |
| 21 | Reconcile pending calendar pushes | Automatic, right after a calendar sync | main, already fully background | No | None at all | Scales with backlog size | No | MAINTENANCE |
| 22 | Generate prep brief for a meeting | Calendar "Prep brief" button, a deep-link notification, or the "Meeting now" live-call banner | main, one AI call (result is cached — a second click is instant) | Partial | Boolean spinner, only inside the open popup | Several seconds | No | INTERACTIVE |
| 23 | Auto-update download | Settings "Download update" button, or automatic | main, uses Electron's built-in updater | No | **Fake** — the library already computes a real percent, the app just never asks for it | Seconds to a couple minutes | No | **MAINTENANCE** — easy real-progress win, see below |
| 24 | Post-call save cascade (the orchestrator) | Automatic, the instant a call ends | main, 6 independent AI steps fired at once, none awaiting each other | Partial per-step; **all of it is lost if you quit the app** within seconds of the call ending, with no resume | None unified (1 of the 6 steps shows a native notification) | Several seconds to ~1 minute total | No | BATCH |
| 25 | Instant post-call brief + copy follow-up email to clipboard | Automatic (opt-in setting, default off) | main, one AI call + clipboard write | No (clipboard write must stay in main by design) | None | Few seconds | No | BATCH |
| 26 | Auto contact-intelligence (after a call, full-auto mode) | Automatic, twice per call (after save, after coaching) | main, fully background | No | None | Not fully measured | No | BATCH |
| 27 | Sales Brain memory extraction from a call | Automatic, twice per call | main, fully background | No — **the one step with a real completion notification today** | Native "Sales Brain learned N things" notification | Several seconds, more with several memory-worthy moments | No | BATCH |
| 28 | Auto objection-mining on new call save | Automatic on every new call, if enabled | main, fully background | No | None (the manual bulk-scan version does track counts, just doesn't show them) | One AI call per new call | No | BATCH |
| 29 | Mic audio capture | "Start" button on a live call | **renderer only** — must be, this is an OS constraint (no main-process microphone API exists) | **Yes, deterministically** | Waveform display only | Life of the call | Yes, clean stop | **LIVE** |
| 30 | Buyer-side (loopback) audio capture | Consent flow during a live call | renderer only, same OS constraint | **Yes** | None | Life of the call | Yes | **LIVE** |
| 31 | Deepgram transcription session | Live call start | **main process already** — good news, see above | Partial — architecturally fine, killed only by an unconditional cleanup call | Live status dot + latency reading | Life of the call | Yes, already has a clean stop path | **LIVE** |
| 32 | Live coaching-cue engine | Automatic during a live call | **renderer only**, zero backup in main | **Yes**, completely | Live cue card / suggestion rail | Life of the call | Resets with the call | **LIVE** |
| 33 | Live deal-intelligence engine (feeds Tier 1/2 above) | Automatic during a live call | **renderer only**, zero backup in main | **Yes**, completely | Live health-score meter | Life of the call | Resets with the call | **LIVE** |
| 34 | Ambient call detection (background "did a call just start" watcher) | Runs continuously once the beta feature flag is on | main, fully independent, self-scheduling | No | Tray icon + overlay window | Runs for the life of the app | Yes (pause/stop already exist) | MAINTENANCE — **this is the one existing example of "already does it right," worth modeling Phase 4 on** |
| 35 | Onboarding answer extraction (Sales Brain) | Onboarding interview, one question at a time | main, awaited inline (the one M25 operation that blocks a button on an AI call) | Partial | None | Few seconds | No | INTERACTIVE |
| 36 | Nightly Sales Brain consolidation | Automatic, ~once/day on app launch | main, fully background | No — but also completely invisible, no "is it running" indicator anywhere | None | Tens of seconds to minutes | No | MAINTENANCE |
| 37 | First-time AI memory-search model download (~23MB) | Automatic, whenever anything first needs it (no fixed trigger) | main | No, but **silently stalls whatever feature happened to trigger it first** — already caused one real slowdown in production | None | Up to ~48s observed | No | MAINTENANCE |

**No export/CSV features exist anywhere else in the app** — I searched every screen (Analytics, Past Calls, CRM, Contacts, Tasks). The only export capability in the entire product today is the Coach PDF export (row 6).

---

## Screen-by-screen navigation map

| Screen | What it owns that's "live" | What happens when you leave | Risk |
|---|---|---|---|
| Home | One read-only API-key check | Nothing lost, safe to redo | None |
| **Live Calls** | **Mic + buyer audio, the transcript, live coaching cues, live deal-intelligence** | **Mic stops, transcription session ends, and — critically — the transcript is thrown away with no save.** The Stop button arms a save first; navigating away does not. | **High** |
| Past Calls | In-flight AI buttons on the open call (summary/coach/commitments/etc.) | Work finishes and saves in the background; you just don't see it until you reopen the call | Low |
| Tasks | Nothing beyond normal form state | Nothing lost | None |
| CRM | Nothing beyond normal form state | Nothing lost | Low |
| Calendar | Nothing beyond normal form state | In-flight event edits already saved via background IPC | Low |
| Coaching | One read-only fetch | Nothing lost | None |
| Analytics | Nothing (pure read-only view) | Nothing lost | None |
| Knowledge | Nothing beyond normal form state | Nothing lost | None |
| Team | Nothing (pure read-only view) | Nothing lost | None |
| Settings | N/A itself, but **entering or leaving Settings tears down the ENTIRE app shell**, not just one screen | If you were on Live Calls, this triggers the exact same transcript-loss bug as any other navigation away from it | Low on its own / **High indirectly — this is the actual "I opened Settings and lost my call" scenario** |

One more piece worth knowing about: there's a second, separate floating window (the "detection overlay," used for the ambient call-detection beta feature) that shows Stop/Pause buttons during a call. It's a completely separate mini-window and never itself holds the call data — its buttons just relay a click back to the real window. It doesn't change any of the above.

---

## What this means for Phase 1 (JobManager) design — technical notes for me, included for transparency

- **The AI layer already supports cancellation end-to-end** (the shared code every AI-powered feature calls through already accepts a "stop signal" and threads it all the way to the network call) — but almost none of the 20+ features that use it actually pass one in today. This is good news: Phase 1's cancellation plumbing is "wire up something that already exists," not "invent it."
- **There is currently zero limit on how many AI calls can run at once.** Nothing in the app today would stop 10 AI features from all firing simultaneously and hitting the same rate limits — the "max 2 concurrent" rule for the Interactive lane has to be built entirely fresh.
- **Several operations already use an informal, hand-rolled version of a job** (a background flag + a status the screen polls) — these are the easiest, safest first candidates to migrate in Phase 3, since the pattern already half-exists: Sales Brain import, the objection-library scan, and cloud backup/restore.
- **Notifications are already duplicated 4 separate times** (contact auto-attach, Sales Brain learned-something, alert delivery, mic-helper crash) — each one hand-rolled the same "show a native notification, click to open the right screen" code. Phase 2 should consolidate these into one shared helper rather than adding a 5th copy.
- **There's exactly one system-tray icon today**, owned entirely by the ambient call-detection beta feature. Phase 2's Activity Center indicator needs to share that icon (extend its logic) rather than create a second one — two tray icons would look broken.
- **Auto-update already computes real download percentage internally** (via the Electron update library) — the app just never asks for it. This is a very cheap, real win for Phase 2's progress-reporting goals.
- **Windows notifications are correctly configured already** (`app.setAppUserModelId` matches the installer's app ID exactly) — the class of bug your notes warned about isn't present in the source. Still worth double-checking once on an actual installed (not portable/dev) build, per your own instinct about "works in dev, dies in production" bugs on this app.

---

## Questions I need answered before starting Phase 1

1. **"Import now"** — is it the Sales Brain contacts/deals/calls import (already in the table), or did you actually want a new "drop in a recording, get a transcript" feature? These are very different scopes.
2. Given how serious the live-call data-loss bug is (item #1 up top), would you like me to ship **a small, isolated fix for just that** (arm the same save-before-stop the button uses, on unmount too) as a fast early commit — before the rest of the M26 phases — rather than waiting for Phase 4? It's a much smaller, lower-risk change than the full live-call decoupling, and stops real data loss sooner. Your call — I can also fold it properly into Phase 4 if you'd rather do it once, correctly, as part of the bigger redesign.
3. Any objection to the recommended lane assignments above? A few (marked BATCH) are currently instant background operations that might arguably belong in MAINTENANCE instead — I erred toward BATCH for anything AI-call-driven and MAINTENANCE for anything scheduled/idle-time, matching your spec's own examples.
