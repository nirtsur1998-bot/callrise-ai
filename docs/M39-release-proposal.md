# M39 — the release proposal

**Prepared 2026-09-11. Version and rollout are the founder's; nothing is merged, tagged or
published.** The purpose of this release is specific: every remaining unverified M39 claim —
the dossier in a live call, a cue carrying a client fact, the model round trip, `endedAt` —
can only be tested on the founder's work machine, which gets the app through the auto-update
feed. So this release is honest about its gaps by design. It exists to close them.

## Contents

- [The merge](#the-merge)
- [Two decisions before the tag](#two-decisions-before-the-tag)
- [Version and rollout](#version-and-rollout)
- [What is on the branch, and how each part is verified](#what-is-on-the-branch-and-how-each-part-is-verified)
- [What to watch for on the first real call](#what-to-watch-for-on-the-first-real-call)
- [What users see — the release notes, with the real numbers](#what-users-see--the-release-notes-with-the-real-numbers)
- [The order I would take](#the-order-i-would-take)

---

## The merge

`claude/m39-stage0-attendee-persistence` is **28 commits ahead of `origin/main` and 0 behind** —
counting this proposal's own commit — a fast-forward. 82 files, +9,654 / −101 before the last
two commits (`appVersion`, and this document).

**Gate on the branch tip: 4,415 passed, 0 failed, exit code 0; typecheck exit 0.**
CI green on the last three branch pushes. **One red CI run on the branch**, and it is explained:
`f591395` failed typecheck on a test-fixture cast (`TS2352` in `sinceLastCall.test.ts`), fixed
in `f251121`. Nothing between has gone red.

Not yet done, and required before a tag: the merge itself, the gate on `main`'s own checkout
after `npm ci`, CI on the merge commit, the installer build, and the five feed checks in
`docs/release-feed-verification.md` after the tag — including its rule: **push nothing to `main`
after dispatching until the tag lands.**

---

## Two decisions before the tag

Both are in categories you reserved. I have a recommendation for each; neither is mine to make.

### 1. The client dossier ships with no switch — confirm or gate it

**What happens on upgrade.** When a live call's meeting is calendar-matched to a known contact,
every live cue now begins with that buyer's dossier: hand-entered contact fields, prior-call
summaries, open and kept promises, the deal stage, and **their verbatim quotes from earlier
calls**. It goes to the user's own AI provider on their own key. It is gated only on the match
existing — **no setting controls it**, including the contact-intelligence mode.

What bounds it, checked rather than assumed:

- the consent gate runs first — a consent-blocked cue carries none of it;
- a mono cue declaring no buyer content still carries **earlier** quotes, because those are
  stored facts, not this call's audio (recorded on BUG-263's egress table);
- precedent: the prep brief already sends a `LAST CALL` block to the same provider;
- **no shipped privacy copy is made false by it** — I searched the renderer for every
  "never leaves / stays on device / not sent" string; none covers this.

**My recommendation: ship it ungated in this release, and decide a switch before any wider
audience.** This release's job is one real call on your machine, and a switch nobody has seen
the feature work behind is a guess. But it is a change in what leaves the machine without a new
control, so it is yours.

### 2. Seven existing call records will be rewritten — lazily

The widened non-name guard (`isNonName`) stops displaying speaker identities that are
placeholders — on your profile, **7 identities named literally "someone"**, none typed by you,
none linked to a contact. It runs in `getCall`, and a dozen writers do read → change → write,
so **each of those 7 files is physically rewritten the next time anything writes to that call**
(a title, a summary, a contact link). Not on first launch, and not on sync — `importCall` reads
the raw file, so the sync does not trigger it.

It removes only what the guard classifies, never a manual identity, never one with a contact
link. **My recommendation: accept it.** It is small, benign and already how the older, narrower
guard behaved — but it rewrites existing calls, which is your line.

---

## Version and rollout

**Version: I would call it `1.12.0`.** A minor, not a patch, because what is sent to the AI
provider on live cues changes for every user with a calendar-matched contact, the Live screen
gains a new control, and Call Detail gains a new notice. `1.11.3` would tell people nothing
changed for them.

**Rollout: 100% is defensible this time**, and the reason differs from M37's staged
recommendation. M37 carried an irreversible data migration; **this release has none.** The only
change to existing records is decision 2 above, which removes placeholders lazily. The install
base is small, and the purpose of the release is your machine. If you choose to stage it, say so
and I will write criteria — but staging here would be blast radius, not observation, and I would
rather not dress it as the latter.

---

## What is on the branch, and how each part is verified

| Change | Verified how | **Not** verified |
|---|---|---|
| **Client dossier** at the front of every live cue | Measured through `ensureDossier` on your real records: **30 of 50** contacts get one, byte-identical 50/50, deal stage present 12/12. Prompt contents asserted by driving the real `liveCue` with the model mocked. **In-app IPC cost: 204 ms on a call's first cue, 3 ms after** (median of 5 paired runs, vs 4 ms with no dossier) | The model round trip. A model using it. A live call. |
| **What changed since last call** (a dossier section) | **5 of 50** contacts, measured through the product path: 2 deal moved, 3 promise kept, 1 pushback shifted. An unlisted section is now a compile error | Live, or read by a model |
| **Objection pre-loading** (a dossier section) | **7 of 50** contacts on your records; 19 unit tests | Live |
| **Overdue promises** marked in the dossier | 3 open, past-due tasks on your records | Live |
| **Live identity chip** — "is this Harvey?" during the call | States rendered in the app's stylesheet and screenshotted; wiring pinned by source tests; the keep-across-navigation and reset-on-new-call rules behaviour-tested and red-checked | **A person using it mid-call**, including navigating away and back |
| **Post-call disagreement notice** on Call Detail | Driven in the app; a state change read back off disk; flags **6 of 297** real calls | — |
| **Non-name guard** at both call-file gates and the live-cue boundary | 7 of 7 "someone" identities caught, 0 of 29 real names eaten | — |
| **Meeting attendees** stored for contact matching | Tested; **deleted from the cloud payload** — attendee emails never leave the device | — |
| **`appVersion`** on every saved call | Both save paths stamp it from main; red-checked; crash-safe so it cannot cost a recovery | Takes effect from the first call saved on this build. Absent on every older call, by design |
| **BUG-268** — interrupted-call prompt had no warning colour | Checked in the **built** stylesheet: `.text-warning` present, `.text-warn{` absent | — |
| **BUG-263** — sandbox egress gate | 4 instruments, driven in-app both ways, found an unlisted egress path on first launch | **Dev-only.** Never installed in a packaged build (pinned), so it changes nothing for users |

**The known hole I would name out loud:** a call abandoned without saving never reaches the
point where the held identity answer is cleared, so a "no, that's not Harvey" can carry into the
next call. One stale question, never a wrong link.

---

## What to watch for on the first real call

This is also the real-call checklist you asked for. Each line says what to look for and **what
counts as failing**.

**Before you start.** Pick a meeting that is calendar-matched to a contact you have spoken to
before (30 of your 50 contacts have enough history for a dossier). An unmatched call gets no
dossier *by design* — that is not a failure.

1. **A cue references something from a previous call** — a past objection, a kept promise, the
   deal stage.
   **Failing:** over a call of ten minutes or more with such a contact, *no* cue ever refers to
   history. One quiet cue is not a failure; the model may reasonably not use it.
2. **The first cue is not noticeably late.** Expected cost is about a fifth of a second, once.
   **Failing:** the first cue arrives seconds later than you are used to.
3. **The identity chip.** If the buyer says their name and it does not match the linked contact,
   the chip asks. Link it, then go to Pipeline and come back mid-call.
   **Failing:** the chip asks you again after you come back, or it said "Linked to X when this
   call saves" and the saved call is not linked to X.
4. **A second call with the same buyer, same session.** If the name is heard again, the chip
   must ask again.
   **Failing:** it stays silent because of your answer on the first call.
5. **`endedAt` and `appVersion` on the saved call.** Run this after the call saves:

```powershell
Get-ChildItem "$env:APPDATA\sales-os\calls\*.json" | ForEach-Object { Get-Content $_.FullName -Raw | ConvertFrom-Json } | Sort-Object createdAt -Descending | Select-Object -First 1 title, createdAt, endedAt, appVersion
```

   It sorts by `createdAt` inside the file, not by file date, because a sync restamps every file.
   - `appVersion` shows the new version **and** `endedAt` is present → the BUG-242 fix works;
     close the question.
   - `appVersion` shows the new version **and** `endedAt` is empty → **failing**: the fix itself
     does not work, and it is no longer an old-build question.
   - `appVersion` empty → the call was saved by an older build; the update has not applied.

---

## What users see — the release notes, with the real numbers

You asked that the real numbers go into whatever the user sees. **Nothing in the app describes
the dossier or "what changed" today**, so the release notes are that surface. Draft:

> **CallRise now remembers who you're talking to.**
>
> - **Live cues use what you already know about the buyer.** When your call's meeting matches a
>   contact you've spoken to before, cues start from that history — past objections, promises you
>   made and kept, and where the deal stands. This needs earlier calls with that contact, so it
>   applies to some contacts, not all: on the profile it was tested on, 30 of 50.
> - **"Since your last call."** When something has moved since you last spoke — the deal changed
>   stage, you completed a promise, or their pushback shifted — the coach knows. This is
>   deliberately rare: on the tested profile it applied to 5 of 50 contacts. Most calls will not
>   show it, and that is expected.
> - **"Is this Harvey?"** If the name a buyer gives doesn't match the contact your meeting is
>   linked to, CallRise asks during the call instead of after.
> - **This information goes to your AI provider** as part of each live cue, using your own key,
>   the same way call prep already does.
> - Fixed: the "we found a call that was never saved" prompt now shows its warning colour.

---

## The order I would take

1. You decide the two questions above, and version and rollout.
2. Merge — fast-forward, `origin/main` to the branch tip.
3. `npm ci` and the gate on `main`'s own checkout; CI on the merge commit.
4. Build the installer from that clean checkout.
5. Tag and dispatch; push nothing to `main` until the tag lands.
6. The five feed checks.
7. Your first real call, with the checklist above.
