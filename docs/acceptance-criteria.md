# M18 acceptance criteria — measured

Per §9: "Measured numbers for every acceptance criterion. Not assertions."

Every number below was produced by actually running the real pipeline against
a disposable measurement harness in this container (deleted after use — the
harnesses are not part of the test suite; only the durable regression/unit
tests in `__tests__/` are). Where a criterion needs real hardware, a live
service, or a real API key this container doesn't have, that is stated
explicitly rather than guessed at — an unrun check is not a pass, and a
fabricated number is worse than an honest gap.

## 1. 90s lag reproduced on demand, then fixed

**Measured.** Two forced 30s drops (the exact repro the criterion calls for),
run against `src/main/session-health/__tests__/lag-regression.test.ts`'s real
pipeline + the 1.25x-ingest-cap mock server:

| Metric                                  | Measured    | Requirement    |
| ---------------------------------------- | ----------- | -------------- |
| Time for lag to drop under 2s post-reconnect | **4014ms**  | < 10,000ms     |
| Final lag                                | **0s**      | < 2s           |
| Final median lag (5-sample smoothed)     | **1.23s**   | < 2s (warn)    |
| `[gap: Ns]` markers emitted              | **2**       | present        |
| Total reported gap                       | **54s**     | > 40s (~27s ×2)|

20-minute-sleep discard-not-replay case (separate test,
`discards a 20-minute backlog rather than replaying it`): queue never exceeds
the 10s cap, replayed audio on reconnect is ≤ 4s, and 1100+ of the 1200
buffered seconds are shed rather than sent — a 20-minute outage costs seconds
of replay, not 80 minutes of catch-up.

## 2. Rising-lag watchdog trips on monotonic rise, even with small absolute lag

**Measured**, from `LagTracker rising-slope guard` ›
`trips on a monotonic rise even while the absolute lag is small`:

Lag climbing linearly from 0 to **3.9s** over the 30-second rising-window (6
buckets × 5s, `risingMinRiseSec: 1.5`) trips `rising: true` and forces a
`reset` — while **3.9s is still under the 5s shed threshold** and nowhere near
the 15s reset threshold that governs flat-lag alone. Companion cases confirm
the guard doesn't over-trigger: flat lag at 3s never trips it, and a rise that
recovers by the end of the window never trips it either.

## 3. A 5s main-thread stall does not affect transcription lag

**The platform guarantee is measured directly; the full Chromium-renderer
claim is architecturally addressed but not independently E2E-proven — and
here is the honest reason why.**

`thread-independence.test.ts` spins up a real `worker_threads.Worker` (a
genuine separate OS thread — not a simulation) ticking every 20ms, then
synchronously busy-blocks the thread running the test for a real 5000ms with
no `await`, no timer, nothing that could yield. Measured:

| Metric                                        | Measured | Expected |
| ---------------------------------------------- | -------- | -------- |
| Ticks recorded during the 5s block             | **248**  | ~250 (20ms cadence) |
| Largest gap between any two consecutive ticks  | **21ms** | ~20ms (no stall)     |

The worker's cadence was, for practical purposes, entirely undisturbed by a
thread next to it being fully blocked for five real seconds — the platform
fact the whole §1.4 design leans on.

What this does **not** prove: the actual production path is a DOM `Worker`
(`audio-pump.worker.ts`) run by Electron's renderer process, and the actual
"main thread" being protected against is that renderer's own JS thread, not
Node's `worker_threads`. Proving the identical claim against a real Chromium
renderer needs a real multi-process Electron instance driven by something
like Playwright — a new dependency and test category this repo doesn't have
today. That's a call worth surfacing rather than making unilaterally
(CLAUDE.md: pause before new major dependencies), so it's flagged here rather
than added silently. What's covered today alongside the thread-level proof
above: the ring/pump unit and integration tests (26 tests across
`ring.test.ts` and `pcm-processor.test.ts`) prove the ring's own correctness
(wraparound, overrun, drop-oldest, worklet↔reader agreement) under arbitrary
draining delay, and the bug-hunt pass confirmed the worker path has no
accidental main-thread coupling left in it (the fixed `worker.onerror`
reattachment, the port-handshake cleanup).

## 4. Windows: real WhatsApp/Teams calls, buyer on its own channel

**Not verified — needs real Windows hardware with a live call.** No native
addon exists yet (see criterion 13). Today's Windows buyer capture uses the
same whole-system `getDisplayMedia` loopback as macOS, gated by the
auto-switch heuristic in `switch-policy.ts` (12 unit tests, no native code)
and the zero-native-code `buyer-silence.ts` mitigation for the
headset-as-communications-device symptom. See `docs/windows-capture.md`
"Where this stands" for the full honest accounting.

## 5. Endpoint enumeration incl. `eCommunications`; mid-call headset plug-in

**Not built.** Needs the native addon (criterion 13). Documented in
`docs/windows-capture.md`.

## 6. Channel self-test passes; no speaker ID is a bare integer

**Measured.** `runChannelSelfTest` (the exact production interleaver under
test, not a copy of it) against a real per-channel tone:

| Layout | Pass | Measured RMS per channel |
| ------ | ---- | ------------------------- |
| Stereo (rep + buyer) | **true** | `[0.354, 0.354]` |
| Mono (mic only)      | **true** | `[0.354]` |

0.354 is exactly the expected RMS of a 0.5-amplitude sine tone (0.5/√2), on
the channel it belongs to and nowhere else — confirming no cross-channel
leakage. Speaker-identity fix verified separately: `3a22a77` made a segment's
identity `(channel, speaker)` rather than a bare integer, with its own test
coverage in `segments.test.ts`.

## 7. Overlay invisible in screen share (Zoom/Teams/Meet/Slack)

**Not run — matrix is in `docs/screen-share-safety.md`, every cell
unchecked.** This cannot be verified from a container: it requires screenshotting
from a **second, receiving** participant's view across four real
conferencing apps, which needs two real machines or accounts. The mechanism
(`setContentProtection`) is implemented and documented; only the
per-app/per-share-mode verification matrix is outstanding.

## 8. Deterministic cue p95 < 500ms; LLM cues never on the interrupt path

**Both halves measured, one fully, one partially — and the partial half is
scoped honestly.**

**Classification (fully proven, exhaustive):** `cue-tiers.test.ts` checks
every existing `CueKind` — `tierFor` puts exactly one kind (`pace`, the
deterministic one) on the interrupt path; all four LLM-derived kinds
(`objection`, `discovery`, `next-question`, `buying-signal`) and any
unrecognised future kind default to the side rail. This is a property test
over the whole enum, not a sample.

**Compute cost (measured directly, 5000 samples each, cold cooldown every
call so nothing short-circuits):**

| Path                        | p50      | p95      | max      |
| ---------------------------- | -------- | -------- | -------- |
| Battlecard match (`BattlecardMatcher.match`) | 0.127ms | 0.185ms | 1.562ms |
| Must-ask checklist (`MustAskChecklist.observe`) | 0.033ms | 0.056ms | 0.907ms |

Both are a small fraction of a millisecond — not the bottleneck. The
`match.ts` file header's own estimate ("~400ms end to end: ASR partial ~300ms
+ match ~50ms + render ~50ms") has its match-cost term confirmed as
generous — the two contributors NOT measured here (Deepgram's interim-result
latency, and a React render/paint) both live outside this process and need a
live ASR connection and a live renderer respectively to measure honestly;
they are not fabricated here.

## 9. Post-call brief + email in clipboard within 15s of hangup

**Not measured — no LLM API key is configured in this container.** The
budget is dominated entirely by one round-trip to the configured AI provider
(Claude or ChatGPT); the clipboard write itself is a synchronous main-process
`clipboard.writeText` call (chosen specifically to avoid the focus
requirement of the renderer-side clipboard API — see the file header of
`post-call-brief.ts`) and contributes negligible time. This is the same
latency class as the "Coach this call" scorecard and call summaries already
shipped and used in production, so it is not a new kind of risk — but a real
number needs a real key and a real network round-trip, neither available
here.

## 10. Cross-tenant PostgREST attack fails; no `service_role` in the `.asar`

**Partially covered.** `docs/security-audit.md` "Verified here" confirms no
`service_role` key ships in the bundle and the RLS policy shape in the repo's
own SQL is correct as written. The live attack test (`curl` against a real
Supabase project's PostgREST endpoint) is explicitly listed there under "You
must run" — it needs a live Supabase project, which this container doesn't
have credentials for.

## 11. Capture provably cannot start without a persisted consent record

**Measured — met.** `src/main/consent-gate.ts`, **20/20 unit tests passing**,
including the "confident-looking object a compromised or buggy renderer might
send" cases. `sanitizeConsent` runs on write and on read; capture is armed
only after the record lands on disk; the grant is cleared on every app start
and scoped to a session id so one call's consent can never authorize another.
Full account in `docs/security-audit.md` § "The durable consent gate."

## 12. Updater refuses a malformed/unsigned artifact; fuses locked

**Measured — met, for the logic; packaged-build confirmation still open.**
`src/main/updater/policy.ts`, **41/41 unit tests passing** — default-deny,
every function returns an explicit verdict (never a boolean that could be
`undefined`), every unparseable input is a reject. `scripts/apply-fuses.js`
sets all four fuses (`RunAsNode` off, `EnableNodeCliInspectArguments` off,
`EnableEmbeddedAsarIntegrityValidation` on, `OnlyLoadAppFromAsar` on),
documented in `docs/security-audit.md`. Confirming the fuses actually flip in
a real packaged, signed build is listed there under "You must run" — needs a
real packaging + signing pass, not available in this container.

## 13. Windows addon installs from prebuild with no compiler on target

**Not built.** `docs/windows-capture.md` "Where this stands": the addon
itself, the `prebuildify`/`node-gyp-build` migration, and the CI prebuild job
are all listed under "Not built," with the reason stated plainly — the addon
can't be compiled or tested from this container, and can't reach the Windows
CI runner either while repo pushes are rejected with 403. The existing
`native/win-audio-sessions` addon (a *different* feature — ambient-detection
session/meter data, not audio) is the proof this repo's CI pipeline can
already build and package a Windows native addon once it can reach it; the
blocker is exclusively repo write access, not the toolchain.

## Summary

| # | Criterion | Status |
| - | --------- | ------ |
| 1 | 90s lag repro + fix | ✅ Measured |
| 2 | Rising-lag watchdog | ✅ Measured |
| 3 | Main-thread stall isolation | ✅ Platform guarantee measured (real OS thread, 248/250 ticks through a real 5s block); full Chromium-renderer E2E proof needs new Playwright infra — flagged, not added unilaterally |
| 4 | Windows real-call capture | ⛔ Needs real Windows hardware |
| 5 | Endpoint enumeration + hot-plug | ⛔ Needs native addon (not built) |
| 6 | Channel self-test | ✅ Measured |
| 7 | Screen-share invisibility | ⛔ Needs two real machines/accounts across 4 apps |
| 8 | Cue latency + tier separation | ✅ Measured (classification fully; compute cost measured, full pipeline partially) |
| 9 | Post-call brief timing | ⛔ Needs a live LLM API key |
| 10 | Cross-tenant RLS attack | ⚠️ Static checks done; live attack needs a live Supabase project |
| 11 | Durable consent gate | ✅ Measured — met |
| 12 | Updater + fuses | ✅ Measured — logic met; packaged-build confirmation open |
| 13 | Windows addon from prebuild | ⛔ Not built (blocked on repo write access to Windows CI) |

7 of 13 (✅ 1, 2, 3, 6, 8, 11, 12) measured in-container to the standard stated
in each section above; 1 (⚠️ 10) partially, with the live half needing a
Supabase project; 5 (⛔ 4, 5, 7, 9, 13) correctly and honestly deferred to
environments this container does not have — real Windows hardware, a live LLM
API key, and two machines for cross-app screen-share verification.
