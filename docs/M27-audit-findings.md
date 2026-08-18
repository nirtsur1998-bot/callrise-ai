# M27 — Phase 0 Audit Findings

**Status:** Phase 0 complete, 2026-08-14. 10 parallel research passes (A–J) + adversarial verification on the 6 highest-stakes claims. Everything below was read from actual source in this worktree (`C:\Users\User\Desktop\callrise-m27`, branch `claude/m27-field-hardening`, off `main` @ v1.2.4) — no guessing. Verified claims are marked ✅ CONFIRMED (independently re-derived by a second agent that tried to refute them).

Legend: **Type** — BUG (real defect) / IMPROVEMENT (works, could be better) / QUESTION (unresolved) / DOC (documentation drift only). **Severity** — Critical / High / Medium / Low.

---

## 🔴 CRITICAL — privacy

### F1. `askCoach()` sends buyer transcript to a third-party AI provider with no consent check ✅ CONFIRMED
**File:** `src/main/live-cue.ts:142-176` (askCoach), caller `src/renderer/src/features/live/components/AskCoach.tsx:35`
**Type:** BUG — Critical

Every other live-call AI feature that can see buyer content (`liveCue`, `analyzeDealTier1`, `analyzeDealTier2`) checks `consentPermitsCapture(sessionId)` fresh, immediately before calling the AI. `askCoach` — the "Ask the coach" panel, rendered unconditionally on the live-call screen — has no such check anywhere in its chain. It sends `segments.map(s => s.text)`, the full raw transcript including buyer-channel content, straight to the configured AI provider.

**Concretely:** buyer consents to capture, buyer says something sensitive, rep revokes consent mid-call — the already-captured buyer words are still sitting in the renderer's `segments` state. Any time after that, clicking "Ask the coach" ships those words to a third-party API with zero gate. This is the same class of bug as BUG-014/BUG-028 (bookmarks), just in a code path that never got the fix.

### F2. Raw call journal keeps full, unfiltered, unencrypted buyer transcript on disk forever ✅ CONFIRMED
**File:** `src/main/live/call-journal.ts`, `src/main/live/live-transcript.ts:299-315`
**Type:** BUG — Critical

`applyConsentRetention` correctly strips buyer content from the *saved Call record* whenever consent wasn't given. But the raw `.jsonl` journal file that was written live, during the call, is never touched by that same rule — a normal successful save only marks it `.done`, never redacts or deletes it. There is no cleanup job anywhere in the codebase for `call-journals/`. Every call, forever, leaves a plaintext file with the full buyer transcript on disk — even for calls where the buyer never consented, or where consent was later revoked. This is the one place in the app that structurally bypasses the consent-retention invariant every other surface (save/read/list) enforces.

---

## 🟠 HIGH

### E1. Consent gate breaks the instant buyer-capture actually turns on ✅ CONFIRMED
**File:** `src/main/consent-gate.ts`, `src/main/transcription.ts:1137`, `src/renderer/.../LiveView.tsx:376,638`
**Type:** BUG — High

Turning buyer-capture on mid-call restarts transcription in multichannel mode, and main mints a **new** session id. The consent grant was persisted against the **old** session id. `consentPermitsCapture` requires an exact match, so from that point on every buyer-attributed AI check fails — silently. Direction is fail-safe (blocks, doesn't leak buyer content), but it means the buyer-capture feature silently stops doing anything for the rest of the call, with zero error shown to the rep. Fix shape: key consent to the stable `callId` instead of the per-restart `sessionId`, or re-persist on every restart.

### E2. Interrupted-call recovery can create a duplicate Call record ✅ CONFIRMED
**File:** `src/main/live/live-transcript-ipc.ts:80-102`, `src/main/live/call-journal.ts:344-347`
**Type:** BUG — High

`recoverCall` saves the Call record, then separately marks the journal `.recovered` — two unguarded steps, no idempotency key linking them. A crash between the two (realistic — same class of interruption `saveInFlight` was built to guard on the *primary* save path, but that fix was never extended here) leaves the journal offered as recoverable again next launch. Recovering it a second time mints a brand-new UUID with no way to detect "already saved" — a second, duplicate Call record for the same conversation.

### A1. `streamWithFallback` (coaching-chat) has no hang ceiling and no cancel button ✅ CONFIRMED
**File:** `src/main/ai/complete-with-fallback.ts:836-1081`, `src/main/coaching-chat-ipc.ts:215-220`
**Type:** BUG — High

The non-streaming path has `HARD_CEILING_MS` (BUG-59's fix for "27-minute spinner"). The streaming path — coaching-chat's only consumer — has no ceiling and no `AbortController` at all. Realistic worst case (primary provider key lapses, other keys remain — the exact scenario BUG-057/058 exist to handle gracefully): the app falls through to the full uncapped 9-model chain, **~13.5 minutes** with no cancel button. The chat panel has no Stop affordance; the only recovery is restarting the app.

### C1. Extracted memories can silently contradict each other and neither ever gets flagged ✅ CONFIRMED
**File:** `src/main/memory/extraction.ts` (GUARDRAIL_PROMPT), `src/main/memory/consolidation.ts:111-138`, `src/main/memory/memories-store.ts:52-54`
**Type:** BUG — High (this is the headline Sales Brain quality target)

Every auto-extracted memory starts as `status:'hypothesis'`. Contradiction detection only compares a new candidate against already-`active` (trusted) memories — two contradictory hypotheses (old stance vs. new stance) coexist forever with nothing ever flagging the conflict, even after each independently crosses the 3-episode promotion threshold. This is the most likely mechanism behind the founder's own observed bug (an extracted "don't chase it yet" that should have been superseded by a later "let's move now").

### D1. Sales Brain backfill resume re-runs already-paid-for AI extraction ⚠️ not adversarially re-verified
**File:** `src/main/memory/backfill-ipc.ts:51-118`, `src/main/memory/backfill.ts:227-269`
**Type:** BUG — Medium-High

Unlike the objection-scan adapter (naturally resumable via a disk-persisted "already mined" flag), backfill has no checkpoint at all. A crash at call #150 of 200, followed by Resume, re-extracts (and re-bills) all 150 already-successful calls. Not data corruption (consolidation dedupes at storage), but real wasted AI spend that scales with how deep the import got before the crash.

### F3. `docs/session-health.md` describes a lag-reset mechanism that CAUSED a real bug, as if it's still the design
**Type:** DOC — High

The doc says lag-resets are hard-capped at 3 per 10 minutes. That cap was deliberately removed after M22 found it let lag grow unbounded (a real report of 70+ second lag). Current code is backoff-only, no ceiling. Anyone debugging a future lag incident using this doc would be pointed at a mechanism that doesn't exist and was itself the cause of a past incident.

### F4. `docs/ai-providers.md` describes roughly a third of the real system
**Type:** DOC — High

Documents 2 providers (actual: 8), a `maxRetries` field that was deleted and explicitly replaced by the entire cooldown/pacing/ceiling subsystem this audit spent most of its time in (Agent A), and 5 purposes (actual: 12). A developer following this doc would edit a field that no longer exists and miss the whole reliability subsystem.

### F5. `docs/M26-phase4.5-design.md` describes an architecture that was deliberately never built
**Type:** DOC — High

Describes moving live-call engine state into main-process singletons with new IPC handlers. The actual (founder-approved) fix was much smaller — hoisting existing renderer hooks above the navigation boundary. The design doc was never annotated as superseded; a future session "continuing" it would be redoing already-abandoned work or introducing a regression into a decision that was closed for a reason.

### H1. `CALL_GAP_MS = 2500` (coaching-cue floor) exceeds Gemini's free-tier rate limit by itself
**File:** `src/renderer/src/features/live/useLiveCues.ts:73`
**Type:** BUG — High

Uncommented guess. At the floor, coaching-cue alone can fire up to 24 requests/minute; Gemini 2.5 Flash free tier is documented at 10-15 RPM. `live`-tier purposes are deliberately exempt from the cross-purpose pacing gate, so nothing else protects this. This is a plausible direct cause of "coaching cues temporarily unavailable" mid-call.

---

## 🟡 MEDIUM

- **A2.** The "every provider blocked" early-exit path always reports "try again in ~60s," even when the real cause is a 4-hour structural-break window — `soonestExpiry` only inspects the cooldown map, never structural-break/pacing state. Wrong user-facing message + wrong persisted health record. `src/main/ai/complete-with-fallback.ts:588-605`.
- **B1.** Fallback log confirms the pre-fix spiral really happened in the field (198 rapid-fire identical failures against a synthetic `legacy:google` id, ~3h before the cooldown fix landed) — good corroborating evidence BUG-058 was solving a real problem, but the log doesn't yet cover any time *after* the full set of BUG-057/058 fixes shipped. Re-pull in a few days for real post-fix signal.
- **B2.** `openrouter-nemotron-3-ultra` fails 100% of the time it's tried (23/23, always a 400) — reads as a stale/wrong catalog entry, not bad luck. `openrouter-auto-free` (last-resort fallback in several chains) fails 88% of the time it's reached, always with structured-output errors — a poor choice for a last resort on features that need reliable JSON.
- **B3.** "Out of quota" failures are logged under `reason:'failed'`, not `'rate-limit'` — so they get zero cooldown per current classification rules and get retried on the very next call. 14% of all logged events.
- **D2.** Retention (500-job cap) is structurally safe from being defeated by volume, but the Activity Center's "Recent" list has no pinned/needs-review section — an unconsumed draft (Generate tasks/CRM note) survives on disk indefinitely but visually sinks under same-day automatic job churn.
- **H2.** `PACING_GAP_MS = 6000` is correctly derived for Gemini but applied uniformly to Groq/OpenRouter too, which can sustain 2-3x shorter gaps per their own documented limits — costs extra fallback-hop latency for no real capacity benefit. Already flagged as deferred in the BUG-058 design doc; that doc also has a stray inconsistency (prose says 3000, code and everywhere else say 6000).
- **J1.** `transcription:transcript` is the one high-frequency live-call IPC channel with no throttle, unlike every job-system channel (which explicitly follows a documented "~4/sec max" policy). May be an intentional latency tradeoff for live captions — worth an explicit decision rather than a silent exception.
- **J2.** Sales Brain's 15-second startup safety cap doesn't actually bound the slow part — the DB open/migration is synchronous, so the `Promise.race` timeout can't fire while it's running. A slow disk or first-run migration can stall the whole app-ready sequence past what the comment promises.
- **G1–G3 (test-suite).** A handful of real hollow-green instances found across the whole suite (see full list below) — none hiding a live-path/consent/data-loss bug behind green, all either vacuous `.every()` checks or proxy-signal tests. Two possible new taxonomy species found: **"the conformance suite that silently no-ops on the platform it targets"** (WindowsAdapter's native-addon contract test passes trivially when the addon isn't compiled, with no visible skip signal) and **"testing a retired/frozen reference module"** (`segments.test.ts` thoroughly tests code that's explicitly marked dead — the real production logic is a hand-duplicated copy elsewhere that this suite never touches).
- **F6, F7.** `docs/bugfix-once-and-for-all.md` describes the BUG-022 device-ownership guard as active; it was deliberately deleted per an explicit founder decision recorded in the vault (M24 doc) — not a code bug, just a doc that needs a one-line correction so a future reader doesn't think a cross-account leak protection still exists. `docs/detection.md` overstates the Windows overlay's visual treatment (an acrylic effect that was tried and reverted for looking wrong on real hardware).
- **I1.** No evidence found of a shipped "Diagnostics Export" feature beyond the existing `--diagnose` CLI report (which is itself clean — no keys/transcripts/memories). Flagged as open, not a gap in what exists today.

---

## 🔵 LOW

- **C2.** Memory Center's "Per client" view has no per-contact grouping — every client's memories interleave in one flat list, no way to review/correct a specific client's wrong memory without reading everything.
- **C3.** No recency weighting anywhere memories are ranked for retrieval or profile compilation — an 8-month-old fact competes equally with yesterday's.
- **H3–H8.** The rest of the "chosen not measured" constants (`STRUCTURAL_BREAK_MS`, `HARD_CEILING_MS` values, `DEFAULT_COOLDOWN_MS`, `PERIOD_EXHAUSTED_DEFAULT_MS`, catalog `CACHE_TTL_MS`, `LEGACY_TAIL_MAX`) are honestly documented as judgment calls, internally consistent, and the fallback log doesn't yet have enough of the right kind of data to tighten any of them further. No action needed now; worth another pass once the log has more post-fix volume.
- **D3.** LIVE lane exists and is correctly implemented but has zero production registrations today — Phase 4/4.5 built a separate main-owned mechanism for the live path instead. Worth confirming this is the deliberate final shape rather than a dropped migration step.
- **E3.** Live-call pill briefly disappears during any mono↔multichannel restart (the `'connecting'` state isn't in its visibility allow-list) — momentary, but happens exactly when the "still on a call" reminder matters most.
- **J3.** Native Sales Brain modules (`better-sqlite3`, `sqlite-vec`) load unconditionally at startup even for users who never enable the feature — `embeddings.ts` already shows the better pattern (dynamic import gated behind first use) elsewhere in the same subsystem.
- Remaining G-series (test integrity) and F-series (doc drift) items are listed in full in the two source audit transcripts; omitted here for brevity since none affect load-bearing/safety behavior.

---

## ❓ Open questions, not yet resolved

- Whether `coaching-chat`'s uncapped-chain worst case (13.5 min) is common in the field or rare — depends on how often a user's default provider key lapses while others remain configured. Not measurable from the current log (too little coaching-chat volume logged).
- Whether the Memory Quality Eval Harness (built and runnable, `src/main/memory/__tests__/memory-quality-eval.test.ts`) produces good numbers — it needs a real API key in the environment to run; no baseline captured yet.
- Whether any of the several "verified clean" areas (job cancellation sample, notification correctness, key storage, diagnose.ts) would look different under a larger/adversarial sample than what was checked — Phase 0 sampled broadly but not exhaustively everywhere.

---

## What's already good (verified, not just assumed)

- catalogId-vs-provider-id keying is now consistent everywhere in the pacing/cooldown/taxonomy code — the exact bug class found once during M26 does not recur.
- Walk-order exhaustion (everything cooled down + paced + broken at once) fails honestly, never hangs or spins.
- `SAME_MODEL_RETRY_LIMIT` is enforced identically on both the streaming and non-streaming paths.
- Consent freshness for `liveCue`/tier1/tier2/bookmarks/memory-extraction (post-save, post-coach, backfill) is all correctly re-read at execution time, never snapshotted — the one exception found is `askCoach` (F1, above).
- API key storage is sound: OS-level encryption, 0600 permissions, only masked hints ever surface.
- Job-history retention cannot be defeated by volume; protected (unconsumed/failed/queued) jobs are structurally exempt from pruning.
- The Windows JobManager test flake is confirmed test-isolation-only, not a production bug.
- No renderer-side memory leaks or unbounded buffer growth found in the live-call/job-tracking hooks; no heavy native dependency leaks into the renderer bundle.
