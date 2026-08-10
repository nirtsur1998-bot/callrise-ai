# Bug Track M2 — "Once and for All" — Full Report

**Branch:** `bugfix/once-and-for-all` (worktree at `../callrise-bugfix`, based on `origin/main`)
**Date:** 2026-08-10/11
**Who this is for:** you, to copy into the Obsidian Bug Tracker and skim before merging.

---

## 0. The most important thing to know first

Before touching anything, I found that almost this entire task had **already been done** in a prior session and just never merged: `origin/claude/windows-build-launch-hsz6x7` had 106 commits of real, tested work — including fixes for backup clock-skew, coaching attribution, the 90s+ lag bug, and the "~5s silence cancels the call" question — that never made it into `main`. I merged that branch in first (clean merge, no conflicts, all tests passing) before doing anything else. See [§1](#1-what-was-already-done-merged-in).

I also want to flag a scope note: the task described a parallel M22 session "building Live Deal Intelligence right now." What I actually found is that M22 (Live-Call Lag Fix and Bug Hunt) had already **finished** on 2026-08-05, five days before this session started. There's no evidence of a currently-running parallel session. I proceeded as a normal single-session task per your confirmation.

---

## 1. What was already done (merged in)

Merging `origin/claude/windows-build-launch-hsz6x7` into `main` closed these immediately, with existing tests:

| # | What it was | Status |
|---|---|---|
| BUG-001 | Backup clock-skew — used the device clock instead of server time | ✅ Fixed (M21 Phase B) |
| BUG-002 | Coaching cues attributed to the wrong speaker | ✅ Fixed (M21 Phase C) |
| BUG-004 | Windows buyer-side capture failed on real VoIP calls (wrong render endpoint) | ⚠️ Fixed in code, **not yet verified on real hardware** — see QA checklist |
| BUG-005 | Stale mic device after a driver reinstall | ✅ Fixed (M21 Phase E) |
| Q4 | "~5s silence cancels the session" | ✅ Answered: not a bug. No such cutoff exists anywhere in the code. |
| Q5 | 90+ second transcription lag | ✅ Found & fixed: a hard cap of 3 lag-resets per 10 minutes could leave lag unbounded once burned through |
| BUG-013 through BUG-019 | Ten more bugs from the M21/M22 review and bug-hunt passes (practice-mode gap markers, a real privacy leak in bookmarks-vs-consent, a broken Mistral provider, a Gemini schema gap, deleted calls resurrecting, a stop-while-connecting race) | ✅ All fixed |

Full detail on each of these is in the Bug Tracker's own entries (BUG-001 through BUG-019) — I didn't redo that work, just verified it by running the full test suite (66 files, 829 tests) and confirming it merged cleanly.

---

## 2. The 3 "must-fix" HIGH bugs — final status

| # | What it was | Status |
|---|---|---|
| 1. Backup clock-skew | Same as BUG-001 above | ✅ Fixed (already merged in) |
| 2. Coaching attribution | Same as BUG-002 above | ✅ Fixed (already merged in) |
| 3. RT-safety in `AudioRing.hpp` | Lives in the separate `salesos-virtualmic` repo — **Mac-only, never pushed to GitHub, not reachable from this Windows session** | 🔴 **BLOCKED — needs a Mac-side session.** See §6. |

---

## 3. New bugs found in the full sweep audit — fixed now

I ran six parallel audits (live transcription/audio, diarization/coaching, tasks/calendar sync, backup/auth, consent-flow verification, virtual mic/call detection) across every core flow, plus your own report about reminders not working. Two were **Critical** (real, deterministic bugs affecting core features), seven were **High**. All nine are fixed, tested, and committed — one commit each on the branch.

### Critical

**BUG-021 — Coaching scorecards came back completely empty for any call recorded without an AI key.**
*Plain language:* if you record a call without an AI provider key set up (which the app fully supports — you can add a key later), the app couldn't identify who the rep was *during* the call. Later, when you add a key and click "Coach this call," the AI correctly figures out who the rep is — but a one-line bug threw that answer away, so the report came back with 0% talk time, no strengths, no evidence, nothing.
*Root cause:* `isRepSegment()` in `coach-attribution.ts` treated the label `"unknown"` (meaning "not identified yet") as if it meant `"confirmed not the rep"`, so it never used the AI's fresh guess.
*Fix:* it now only trusts a definitive `"rep"`/`"other"` label; anything genuinely unresolved falls back to the AI's guess, same as it already did for old pre-2026 calls.
*Status:* FIXED-VERIFIED (regression tests reproduce the exact scenario).

**BUG-022 — Signing out didn't clear anything except the login screen.**
*Plain language:* every other local secret and file — your calls, transcripts, tasks, contacts, deals, knowledge base, connected Google/Outlook calendars, and stored AI API keys — stayed on the computer, fully readable and usable by whoever signs into a *different* account on the same machine next. This only matters if this computer is ever shared or handed off, but if it is, it's a real privacy problem.
*Fix (per your choice — "block + prompt on mismatch"):*
- Sign-out now always disconnects Google/Outlook and clears every stored AI key.
- A NEW check runs on every sign-in (and on restoring a saved session at launch): if this computer's local data already belongs to a *different* account, the sign-in is refused and immediately reversed — you'll never even briefly see the wrong account's data.
- A new screen explains this and offers **"Wipe this device's data & continue"** — the only way past it, and it says clearly there's no undo.
*Status:* FIXED-VERIFIED (19 new tests; I confirmed 4 of them genuinely fail without the fix, so they're proven to catch the real bug, not just pass trivially).

### High

**BUG-023 — Objection-mining had its own copy of an already-fixed bug.**
The "objection & response" AI feature merged speaker turns across a call reconnect (when Deepgram's speaker numbering resets) the same way coaching used to, before that was fixed weeks ago. Could misattribute an objection/response pair to the wrong person. Fixed, and this file now has its first tests (it had none).

**BUG-024 — A failed save could look successful.**
If saving an edited task or calendar event failed on disk (e.g., antivirus or cloud-sync briefly locking the file — a real, if rare, Windows scenario), the edit dialog closed as if it worked, and your change was silently lost. Now shows an error and keeps the dialog open so you can retry.

**BUG-025 — Outlook reminders fired at the wrong time, and could duplicate events.**
This is the bug you reported and tested yourself. Root cause: picking multiple reminder times (say 30 and 10 minutes before) used the *closest* one to the meeting instead of the *earliest* — exactly backwards from what the Settings copy promised. Fixed. While in the same code, I also closed a real risk of Outlook creating a duplicate calendar event on any ordinary network hiccup during sync (not just a crash, which was the only case the code defended against before).

**BUG-026 & BUG-027 — A background app-detection check could misbehave.**
A slow "which app is the rep using" check could still fire a "call detected" popup a moment after you'd already tabbed back into CallRise AI. Separately, that same quick-detector completely ignored your per-app "Never ask" setting and the master detection on/off switch. Both fixed.

**BUG-028 — A second spot where a bookmark could keep a buyer's words past a revoked consent.**
Same bug class as the fix from last week (BUG-014), in a second code path that fix didn't cover: a "Clip this" bookmark taken live, right before you revoke consent mid-call, could still get written to the raw file with the buyer's actual words — even though the app's own screens correctly hid it. Fixed by re-checking consent on that specific write, matching the pattern already used elsewhere.

**BUG-029 — Quitting at the wrong moment could corrupt your saved login.**
Your login session was saved to disk asynchronously with no way to guarantee it finished before the app closes. Supabase rotates your login token roughly every hour; quitting in that narrow window could leave a broken, half-updated session file, forcing a surprise re-login next time. Fixed by writing it synchronously (it's a tiny file, not a performance concern).

---

## 4. New findings — Medium/Low, listed for a future pass (not fixed now)

Per your instructions, these are logged but not touched this pass.

| # | Severity | What it is | Where |
|---|---|---|---|
| BUG-030 | 🟡 Medium | The "did you ask about X" live checklist can miss a follow-up sentence that gets merged into an already-scored line instead of appearing as a new one | `LiveView.tsx` / `segments.ts` |
| BUG-031 | 🟡 Medium | A currently-unused ("dormant") fast audio path has no safety check confirming audio really comes from the active call — harmless today because the path is disabled, but risky if re-enabled without this fix | `transcription.ts` |
| BUG-032 | 🟡 Medium | Coaching report PDFs (and the in-app view) show "Speaker 1/2" instead of "You" for evidence quotes from a call that reconnected mid-call | `CoachReportView.tsx`, `coach-pdf.ts` |
| BUG-033 | 🟡 Medium | The floating "call detected" popup silently does nothing if you click it while the main window is closed (Mac tray mode) | `detection-overlay.ts`, `DetectionOverlay.tsx` |
| BUG-034 | 🔵 Low | A "shed audio" diagnostic log can mislabel *why* audio was dropped (still reports the right amount, just sometimes the wrong reason) — cosmetic, but it's the exact log this app asks testers to paste back | `transcription.ts` |
| BUG-035 | 🔵 Low | Post-call summaries and prep-briefs have no built-in protection (unlike coaching) against blending two different people's words across a reconnect — flagged for awareness, can't prove it deterministically since it depends on the AI's own behavior | `summarize.ts`, `post-call-brief.ts` |
| BUG-036 | 🔵 Low | A background "call auto-detected" list grows for as long as the app runs, never trimmed — not currently harmful, but an unbounded leak in a 24/7 process | `detection-service.ts` |
| BUG-037 | 🔵 Low / needs verification | Outlook's all-day event date mapping might land a day early for organizers in Europe/Asia/Australia timezones — flagged as *unconfirmed*, needs a real Outlook account to verify, not a proven bug | `outlook.ts` |
| BUG-038 | Test gap | No automated test drives the real code path for the "cross-talk" (two people talking over each other) warning end-to-end — only the underlying logic is unit-tested | `transcription.ts` |
| — | Note (partially addressed) | Zero test coverage existed for `auth.ts`/`backup.ts`'s network-facing paths (Supabase unreachable mid-sync, etc.). BUG-022's work added solid coverage for the *ownership/sign-out* logic specifically, but the broader push/pull network-failure paths are still untested. | `auth.ts`, `backup.ts` |

---

## 5. Consent flow (M11) — verification result

**PASS.** A dedicated audit confirmed: the consent gate's code has had exactly one commit since it was created — nothing in this pass (or M21/M22) touched it. Buyer-side capture genuinely cannot start without a valid, on-disk consent record; revoking mid-call stops capture within a second or two, not just on the next save; and every read/list/backup path strips transcript, speaker names, and (as of BUG-028's fix) bookmarks when consent isn't held. The only related finding was BUG-028 above, now fixed.

---

## 6. What still needs a Mac session

**BUG-003 — RT-safety issue in `AudioRing.hpp`.** This file lives in the separate `salesos-virtualmic` repo, which is Mac-only and has never been pushed anywhere I can reach from Windows. I searched the whole `callrise-ai` repo and this Windows machine — it genuinely isn't here. Whenever you start a Mac-side Claude Code session, point it at that repo and this acceptance criteria (unchanged from the original ask): no allocations/locks/IO on the real-time audio path, ThreadSanitizer clean under sustained load, a 30-minute capture run with an overrun counter reported, and confirm no regression vs. the DeepFilterNet3/Krisp-parity benchmark.

---

## 7. Everything verified before merge

- `npm run typecheck` (node + web): clean, zero errors, on every commit.
- `npm test` (vitest): **74 test files, 879 tests passing, 9 pre-existing skips, 0 failures** — includes 66 regression tests added or updated in this pass.
- `npx eslint` on every changed file: 0 errors (only pre-existing Windows line-ending warnings, unrelated to this work — see note below).
- For the 6 most safety-critical fixes (BUG-021, 022, 023, 024, 028), I specifically verified the new test **fails without the fix and passes with it**, by temporarily reverting the code and re-running — not just that the test passes now.

**A small note on those line-ending warnings:** `git config core.autocrlf` is set to `true` on this Windows checkout, which converts every file to Windows line endings (CRLF) on disk — including files that were already there before this session. ESLint's formatting rule (which expects Unix line endings, LF) flags all of them. This is a pre-existing environment quirk, not something introduced by this work, and I deliberately did not do a repo-wide reformat to "fix" it, since that would be exactly the kind of unrelated mass-formatting change you asked me to avoid.

---

## 8. Crash/error logging (also added this pass)

A small standing feature, not tied to a specific bug: the app now writes ongoing errors (not just startup crashes, which already had a separate temporary mechanism) to `userData/logs/callrise.log`, capped at 2MB with one rotation, covering both the main process and the on-screen app. Reachable from **Settings → App → "Open log file"**. If anything goes wrong in a future session, that's the one file to send me.

---

## 9. Manual QA checklist

Everything below is a *manual* check on top of the automated tests — things only a real run of the app, on real hardware, can confirm. You'll need this on a **build made on the branch after it's merged to main** (see §10). Where I say "you'll need a second test account," a free throwaway Supabase sign-up works fine.

### Windows steps

1. **Basic smoke test.** Launch the app, sign in, start a short call, let it transcribe, stop it, confirm it saved. This alone confirms the merge didn't break anything fundamental.
2. **BUG-004 — buyer-side VoIP capture (still needs YOUR verification — this was never confirmed on real hardware).** Start a real WhatsApp or Teams call, enable buyer-side capture in CallRise AI, and confirm you actually hear/see the *other person's* audio transcribed, not just your own mic. This is the one item from the merged-in work that was never live-tested.
3. **BUG-025 — Outlook reminders.** Settings → Calendar → connect Outlook, enable two-way sync. Create an event, pick **both** a 30-minute and a 10-minute reminder. Confirm the reminder that actually fires is the **30-minute** one (the earlier warning), not the 10-minute one. (If you don't use Outlook reminders day-to-day, at least confirm Google's still fine: same test, Google side — should already work correctly.)
4. **BUG-025 — no duplicate Outlook events.** Create an event with two-way sync on, then briefly disable your internet for a few seconds right after saving it (to force a retry), then reconnect. Wait for the next sync. Check Outlook directly — confirm there's only **one** copy of the event, not two.
5. **BUG-022 — sign-out clears secrets.** Note whether Google/Outlook show "Connected" in Settings → Calendar, and whether you have an AI key saved in Settings → API keys. Sign out. Sign back in as the **same** account. Confirm Google/Outlook still show connected and your key is still there (nothing should have been lost for the normal case).
6. **BUG-022 — a different account is blocked, not silently shown your data.** Sign out. Sign in with a **different** (throwaway) account. You should immediately see the **"This device belongs to another account"** screen — never your existing calls/tasks in the background. Click **Cancel** — confirm you land back at a normal, empty login screen (not signed in as anyone). This is the most important check in this whole list — if it fails, this is a real privacy issue.
7. **BUG-022 — the wipe flow works.** Repeat step 6, but this time click **"Wipe this device's data & continue."** Confirm: (a) it actually signs you in as the second account afterward, (b) your Past Calls/Tasks list is now empty (the first account's data is gone), (c) Settings → Calendar shows Google/Outlook as disconnected (you'll need to reconnect for this account).
8. **BUG-021 — coaching without a live AI key.** Temporarily remove all AI keys in Settings. Record a short 2-person call (talk into your mic, play a second voice into your speakers/mic, or just do a real call). Save it. Re-add an AI key. Open the saved call and click **Coach this call**. Confirm you get a *real* scorecard — a talk-time percentage that isn't 0%, at least one strength or improvement with a quote under it — not a blank report.
9. **BUG-028 — bookmark + revoked consent.** Start a call with buyer-side consent granted. While the other party is talking, click "Clip this" to bookmark that moment. Then revoke consent mid-call. End the call. Open the saved call — confirm no bookmark from that clip appears (this already worked); this fix specifically protects the raw file on disk, which isn't something you can check without opening the file directly — safe to trust the automated test here.
10. **BUG-026/027 — call auto-detection respects your settings.** In Settings, set one specific app (e.g. WhatsApp) to "Never" under per-app detection overrides, and make sure "Auto-transcribe calls" is on. Bring that app to the foreground (no real call needed). Confirm CallRise AI does **NOT** jump into a recording session for it. Then try an app you left on default settings — confirm it still offers the normal "call detected" prompt.
11. **Existing regression: virtual mic / noise cancellation.** Since this pass touched several core files, do one full pass with your usual virtual-mic setup: confirm the denoised mic still works in a real call, with no new latency or dropouts versus what you're used to.
12. **Existing regression: consent flow.** Decline consent on a call — confirm the "other party" indicator never turns on. Grant it — confirm it does. Revoke it mid-call — confirm the indicator drops back to "mic only" within a second or two, not just after the call ends.

### Mac steps

Everything above applies on Mac too **except step 2** (BUG-004 is Windows-specific — the render-endpoint bug it fixes doesn't exist on Mac) and **step 11** (the Windows virtual-mic driver doesn't apply — instead, do the Mac equivalent: confirm DeepFilterNet3 noise cancellation still works normally on a real call, no new latency).

Additionally, since BUG-022's device-wipe flow also disconnects Google/Outlook and clears AI keys — which on Mac are stored via Keychain (`safeStorage`) rather than Windows' DPAPI — please specifically re-confirm step 7's wipe flow once on a Mac build too, since the underlying encryption mechanism differs by platform even though the code path is the same.

### What you do NOT need to test manually

Everything in §3 (the 9 fixed bugs) has an automated regression test that reproduces the exact bug and proves the fix — those are already verified. The manual steps above are for the things only a real device/network/account can confirm: actual VoIP audio, actual Outlook notification timing, actual cross-account behavior with two real logins.

---

## 10. Merge plan

**This branch merges to `main` first.** M22 (already finished, per §0) has nothing pending to rebase — but if any *other* new session is active on this repo when you do this, have it rebase on top of `main` afterward, not the other way around.

**Run these from the original repo** (`C:\Users\User\Desktop\callrise-ai`), **not** from this worktree (`C:\Users\User\Desktop\callrise-bugfix`) — git won't let you check out `main` in the worktree while it's also checked out there:

```bash
cd C:\Users\User\Desktop\callrise-ai
git checkout main
git pull origin main
git merge --no-ff bugfix/once-and-for-all
```

If that comes back clean (it should — this branch is 116 commits ahead of `main` with no divergent changes: 106 from the already-completed M21/M22 work plus 10 new commits from this session), then:

```bash
git push origin main
```

To clean up the worktree afterward (optional, once you're confident you don't need it anymore):

```bash
git worktree remove ../callrise-bugfix
git branch -d bugfix/once-and-for-all
```

**Before pushing**, please do at least the smoke test (§9, Windows step 1) and the two BUG-022 steps (6 and 7) yourself — those are the highest-stakes changes in this pass and worth your own eyes on them before they go to `main`.

I have **not** pushed anything — every commit is local to this worktree, waiting for you.
