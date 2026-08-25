# M30 overnight audit — HANDOFF

**Written 2026-08-25 at the end of the session. Everything not written here is gone.**

Worktree `C:\Users\User\Desktop\callrise-audit`. All branches off `main` @ `f5d357e`.
**`main` is byte-identical to `origin/main` — nothing was pushed, nothing was merged.**
No file under M28's paths (`src/main/assistant/`, `src/main/ai/`, `src/main/memory/`,
`coaching-chat*`) or M29's (`telemetry/`, `entitlements/`, `backup.ts`, `supabase/`) was
modified by any branch below.

---

## 1. WHAT IS ON WHICH BRANCH

| Branch | Commit | State | What |
|---|---|---|---|
| `fix/BUG-115-deal-intelligence-consent` | `59937f5` | **verified, handed to M29** | Consent leak — the Radar Report kept the buyer's verbatim words after revocation |
| `fix/BUG-116-ship-no-git-history` | `4388ab7` | **verified, handed to M29** | Deletes `M18final.bundle` + `M18final.patch`, which ship 39 commits of source history to every user |
| `fix/BUG-117-build-must-fail-without-denoiser` | `8fa4c14` | **verified** | `beforePack` gate so a missing denoiser actually fails the build, as the config already claimed twice |
| `fix/BUG-111-pause-ends-call` | `47a44f3` | verified | Pause >10 s ended and saved the call, blaming the mic |
| `fix/BUG-114-regenerate-stale-draft` | `98fb4be` | verified | "Regenerate" served the draft the rep had just rejected |
| `fix/preload-escape-hatch` | `732687a` | verified | Removed the arbitrary-channel IPC bridge + `process.env` (AI keys) exposure |
| `fix/BUG-112-sync-failure-comment` | `6f845da` | verified | Comment only — corrected a false justification citing a UI that was never built |
| `claude/overnight-audit` | *(this branch)* | — | The findings report, two decision memos, and this handoff. **No source file.** |

**Merge note:** `fix/BUG-111` and `fix/preload-escape-hatch` both touch `src/preload/index.ts`
and `index.d.ts`. I merge-tested them together: clean merge, and typecheck + both test files
pass on the combined tree. No other pair overlaps.

**Verification standard used on every fix above:** typecheck exit 0; full suite exit 0 with the
test count matching the tests added exactly; `test-output.log` scanned for stray error lines;
and a red-check with the reversion verified **per function** before the result was read.
**None is click-tested in a running Electron app** — all are static + unit-test proofs of
mechanism, and every commit message says so.

---

## 2. BLOCKED ON THE FOUNDER

### Two decision memos, written and delivered — answer with a letter each
- `docs/DECISION-calendar-two-way-sync.md` — **BUG-113.** Remote calendar edits are never
  pulled in, and the next local edit silently overwrites the customer's reschedule. The
  question is who wins a conflict. Options A (remote wins, **recommended**), B (last edit
  wins), C (flag and ask). Also settles a rider: an event deleted in Google is currently
  **re-created** by the next local edit.
- `docs/DECISION-sync-failure-surface.md` — **BUG-112.** A meeting that never reached
  Google/Outlook looks perfectly fine in CallRise. The question is where the failure appears.
  Options A (per-event marker), B (one connection-level banner, **recommended**), C (both).
  The false comment that justified having no surface is already corrected on
  `fix/BUG-112-sync-failure-comment`; only the UI is blocked.

### Other decision-gated items (not yet written up)
- **Inverting `applyConsentRetention` from an allowlist to a closed literal.** It is still a
  named-field list over a `Call` shape that has outgrown it (`summary`, `coaching.evidence`,
  `commitments`, `coachChat`, `notes` all unexamined). Only `dealIntelligence` was reachable
  with unconsented content today — a property of the current call graph, not of the guard.
  `deleteCall`'s tombstone already solves the same problem the safe way.
- **JOBS-11** — a size/age bound on job retention changes what gets deleted.
- **The 6 s undo window / delete-confirm model** — several inconsistencies, all product calls.
- **P-7** — whether Windows arm64 is a supported target at all. It is declared in
  `electron-builder.yml` and ships three dead native subsystems; CI only builds `--x64`.

### With M29
**BUG-115** (consent leak) and **BUG-116** (source history) have both been handed to their live
session with full verification detail. **BUG-117** was offered to them as well, since it
touches `electron-builder.yml`, which is release-flow surface. They own the release flow; this
session did not push or build any release artifact.

Also flagged to them, **not fixed by me because `release.yml` is theirs**: CI runs *Test*
(step 3) **before** the *electron-vite build* (step 4), so the four tests in
`real-worklet-render.test.ts` — which load the real shipped `pcm-processor.js` and prove the
mic and buyer channels are not swapped — are **skipped on every CI run, including every
release**. Swapping the two steps would make them run.

---

## 3. WHAT THE NEXT SESSION PICKS UP FIRST

1. **Confirm BUG-115 and BUG-116 actually shipped.** Both are handed to M29, and species 23
   ("shipped as code but never as deployment") says the handoff is not the shipping. Check the
   live release, not the merge.
2. **Answer-driven work:** if the founder has replied to either decision memo, build that.
3. **Species 36 — budget verification FIRST.** This session's whole failure mode was gathering
   ~60 findings and verifying 8. Gather less; verify as findings land, not in a batch at the end.
4. **The two auditors that never ran:** coaching / knowledge / analytics, and dead-code /
   type-safety. Neither has been attempted.
5. **The ~52 unverified findings stay unverified, on purpose.** Founder's call: *"I'd rather
   have 52 flagged unknowns than 52 confident guesses."* They are marked as such throughout
   `docs/OVERNIGHT-audit-findings.md`. Do not promote any of them without doing the work.

---

## 4. THE RULES THIS SESSION ADDED — read these before touching anything

Three taxonomy species were minted (numbered **36, 37, 38** — 35 was already taken by another
session the same day, caught by grepping the canonical list first). Canonical bodies are in
M26's list; the trigger index has rows for all three.

**Species 38 is the one that matters, and the founder weighted it as the most important
finding of the audit.** A scripted revert can report success while having modified the *wrong
occurrence* — and the resulting green suite impersonates a *different* failure. The trained
reading of green during a red check is "my test is hollow", so the diligent response is to
distrust the test, build a better one, and never notice a shipped guard was deleted. That is
exactly what happened here: `applyConsentRetention` was silently stripped out of `addBookmark`,
BUG-028's live consent fix.

> **The rule, structural: verify a scripted revert by DIFF, not by anchor match. Confirm
> exactly one hunk changed and it is the intended one.** An anchor matching is not evidence
> when anchors repeat — and in a codebase that mirrors a fix across sites, they repeat by design.

**And the standing practice rule that came out of it:** any scripted file operation gets
`git status` checked **immediately** after — not at the end of the batch, while the cause is
still one command back. Two near-misses in one session came from this shape. Saved as a
memory (`scripted-file-ops-check-git-status`).

---

## 4b. THE SUITE'S SKIP COUNT IS ENVIRONMENT-DEPENDENT — read this before trusting a tally

The baseline for this session was **2143 passed / 9 skipped (2152)**. Later runs on fix
branches reported **2147 passed / 5 skipped (2152)**. Same total; four tests moved from
skipped to passing, and no code change could do that.

Cause: `src/main/session-health/__tests__/real-worklet-render.test.ts:22` is
`describe.skipIf(!hasBuiltWorklet)`, gated on `out/renderer/assets/pcm-processor*` existing.
The packaging verification builds created it, so those four ran — and passed.

Two things follow, and the second is the one that matters:

1. **When comparing suite tallies across this session's branches, compare the TOTAL (2152),
   not the passed count.** A passed-count delta may just mean "someone built recently".
2. **Those four tests never run in CI.** `release.yml` runs *Test* at step 3 and the
   *electron-vite build* at step 4, so the asset does not exist when vitest runs. They are the
   tests that load the real shipped worklet and prove the mic and buyer channels are not
   swapped — and the file's own header says the previous self-test called a *reimplementation*,
   so a genuine channel-swap bug could pass cleanly. Logged with M29; `release.yml` is theirs.

This is not species 11 (a test that reports green while proving nothing) — the skip is honest
and visible. But the practical effect on the release pipeline is the same: it never executes.

---

## 5. HONEST NOTES

- **`dist/` is ~700 MB of build evidence**, deliberately left so M29 can reproduce BUG-116 with
  one command (`npx asar list dist/win-unpacked/resources/app.asar | grep M18final`). The
  founder will clear it after.
- **I edited `electron-builder.yml` while a build using it was running.** The `files` list was
  untouched so the BUG-116 asar check remains valid, but it was avoidable uncertainty. Don't.
- **BUG-118's severity was walked back by me, from CRITICAL to MEDIUM**, after finding the
  independent 5-minute idle watcher that caps the exposure. The mechanism is real; the
  "records indefinitely" framing was mine and was wrong.
- **Nothing here is click-tested.** The single highest-value thing a next session could do that
  this one could not is run the packaged app and use it.
