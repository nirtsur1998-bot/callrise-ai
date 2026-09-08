# M35 + M36 + M37 — the release proposal

**Prepared 2026-09-08. Version and rollout are the founder's; nothing is tagged, merged or
published.** This supersedes `docs/M36-release.md`, which proposed 1.11.0 for M35+M36 and was never
cut — so this release carries all three milestones.

## The merge

`claude/m37-close-prepare-wedge-imagine` is **50 commits ahead of `origin/main` and 0 behind**. A
`git merge-tree` against the merge base produces **zero conflict markers** — it is a fast-forward.
Gate on the branch tip (`dd505f8`): **GREEN, 400 test files, 3802 tests, typecheck exit 0.**

### DONE, 2026-09-08 — merged, gated on main's own checkout, installer built

- **Merged.** `origin/main` `edc65da → 3d12ce5`, fast-forward. `git diff` between `main` and the
  branch tip is empty: identical trees.
- **Gate on `main`'s OWN checkout**, in the `callrise-release` worktree, after a full `npm ci` from
  `main`'s lockfile — not the branch's `node_modules`: **GREEN, 400 test files, 3809 tests,
  typecheck exit 0.**
- **Installer built from that same clean checkout**, tree clean at build time, so the walked build
  is the tagged tree rather than a branch's:

  | file | size | sha256 |
  |---|---|---|
  | `CallRise AI Windows.exe` | 170 MB | `2a5e0de02664257b9ddfeeaf13add2145d618d53aad8d6d8d464410b50bf3069` |
  | `CallRise AI Windows Portable.exe` | 334 MB | `49b46105a5ec5797b0b351e93ae209b77727c9c4ef6d5e1f80f8d30d62dd7c76` |

**Still not done:** CI has not run on the merge commit, and the VM walk has not happened. Both
before a tag.

---

## Version: **1.11.0**

Unchanged from the M36 proposal, and M37 does not push it further. It is still a minor rather than a
patch, now for four reasons:

- two `memory.db` migrations from M36 run on every user's store on first launch,
- the Live screen changes for everyone with the design preview on,
- **the privacy copy changes on six surfaces**, which is a user-visible change of what the product
  says about itself, and
- **a one-way data migration is added by M37** — see the rollout note below.

`1.10.1` would tell people nothing changed for them, and something did.

---

## Rollout — my recommendation, and the reason it differs from last time

**Staged, not 100%,** and I want to be explicit that this reverses the founder's own decision on the
M36 proposal. Their reasoning then was sound and still is: the install base is too small for a 10%
cohort to produce a signal, and the release is strictly better than what is shipped.

What changed is that **M37 adds an irreversible data migration that M36 did not have.**

`runQuoteRedactionSweepOnce` (`memory/memory-runtime.ts:162`) runs once on first launch after
upgrade. For every Sales Brain memory whose evidence points at a call that no longer exists, it
**blanks the verbatim quote and keeps the fact**. On the founder's own machine it touched 36
memories, removed 43 quotes and 2,537 characters, and kept 73 memories with zero facts lost — but it
is a permanent deletion of text, on every user's store, with no undo.

It is guarded properly (it refuses to run when the calls directory reads empty while memories exist,
which is the corrupted-read case that would otherwise wipe every quote) and that guard is tested.
The concern is not that it is wrong. It is that **it is one-way, it runs before anyone can look at
it, and the only machine it has ever run on is the founder's.**

So: **10% first, hold for one clean day, then 100%.**

### The ramp criteria — and the honest version first

**I cannot watch a 10% cohort.** Telemetry is off by default, so no counter reaches me; and nobody
reports a quote that quietly vanished, because they never see it go. **"No reports" is not a
criterion, it is the absence of one**, and if that were the whole plan then 10% would buy nothing at
all except a smaller number of people harmed — which is a real benefit, but it is *blast radius*,
not *observation*, and calling it the latter would be the third false claim this milestone caught.

So rather than invent a criterion, I went and closed the hole the criterion would have been watching
for. **BUG-236, found while writing this section:**

`liveCallIds` came from `listCalls`, whose per-file reader ends
`catch { return null } // skip unreadable / corrupt file`. A call whose file could not be read *for a
moment* was therefore indistinguishable from a call the user deleted — and this sweep runs once, on
first launch after an upgrade, on Windows, where a file briefly locked by antivirus is ordinary. It
would have blanked that call's quotes permanently, on a call that still exists, with nothing
recording that it had. The existing precondition only caught the read failing **entirely**; a
**partial** read walked straight through it, and a partial read is both likelier and quieter.

**Now a call is only treated as deleted when a direct filesystem check agrees it is gone.** A file
that exists but did not parse is not a deleted call. Red-checked: ignoring the second instrument
fails two tests.

### What is actually watched, then

| | |
|---|---|
| **The number** | `rescuedByFileCheck` in the sweep's `memory_meta` record — calls the listing thought were gone and the filesystem found alive. **It should be 0.** |
| **Where it is readable** | in any profile's `memory.db`, and in the log, loudly. Not aggregate, not remote — but real, and readable off a machine that reports a problem for any reason. |
| **What non-zero means** | the calls directory read is unreliable on that machine. Quotes were one check away from being destroyed. **Stop the ramp**, because the same condition on a build without this guard is exactly the unrecoverable case. |
| **The founder's own machine** | the sweep has already run there, so it is *not* a data point for the ramp. Say so rather than counting it. |

**The honest promise for the hold day:** it is one machine's worth of evidence — the VM walk, where
I can read the sweep record directly after a first launch on a real profile copy. That is a genuine
check on a real installer, and it is the only observation in this plan I can actually make. The 10%
is blast radius, and I would rather name it that way than dress it up.

---

## THE ONE THING THAT NEEDS A DECISION BEFORE THE TAG

**Three false locality claims still ship.** They are pinned, counted, red in both directions, and
awaiting word-by-word approval that has not happened:

| file | the sentence |
|---|---|
| `features/home/activationSteps.ts` | "Runs entirely on your own device." |
| `features/settings/MemoryCenterSection.tsx` | "Runs entirely on your own device. Nothing is sent anywhere." |
| `features/settings/TelemetrySection.tsx` | "Nothing has been sent from this computer." |

Round five drafted replacements for all three (`docs/M37-copy-round-five.md` §3, items A, B and E).
They are not shipped because privacy copy is approved word by word, every string, and these three
have not been.

**This is a release decision, not a code one.** Shipping 1.11.0 means shipping a release whose
headline internal finding was "the app says something false about where your data lives" while three
of those sentences are still on screen. Approving the three drafts is one message; so is deciding
they wait for 1.11.1.

---

## What a user would notice, by milestone

**M35 + M36** — as written in `docs/M36-release.md`, unchanged: the splash, the truthful mic list,
the sample-call door before any account, the glance HUD, the Sales Brain's lexical channel and
temporal validity, the retryable calendar push, the React #310 crash fix.

**M37**, new here:

- **The privacy page tells the truth, and names a third destination for the first time.** The
  opening card names Deepgram, the AI provider and the backup separately; the "Call recordings"
  toggle is now "Call transcripts", because no call recording has ever existed; and the Deepgram
  sentence appears at the key field, in onboarding, and on the privacy page.
- **Erase actually erases.** A delete that row-level security filtered to nothing used to report
  success. It now counts before and after and refuses to claim an erase it did not perform. Proven
  against production.
- **Deleting a call takes its words out of the Sales Brain and leaves the fact.**
- **"Forget everything" now also deletes the pre-migration backup** it used to leave behind.
- **A meeting cancelled in Google or Outlook is no longer re-created** by an edit in CallRise.
- **The nightly Sales Brain reflection is disclosed** on the card that switches it on.
- **Auto-title works.** The preference survives a reinstall, a restore and an origin change; the
  title no longer depends on the least reliable capability on every free tier; a failure says why;
  there is a manual "Generate title"; and there is an offer to name the calls that never got one.
- **Crash dumps are deleted after 14 days.** Nothing had ever deleted one.

---

## What is verified how

The full item-by-item split is in `docs/M37-close-out.md` — **observed** (driven in the running app
or read off the server, state read back by an instrument sharing no code with the thing under test)
versus **tested** (a red-checked check in the suite). The short version for release purposes:

- The erase path, BUG-213 on production, the auto-title preference, the title fix, the manual title
  action and the backfill were all **driven and measured**, not inferred.
- The disclosure guards assert the **code half first**, so a sentence cannot outlive the behaviour
  it describes.
- **Not driven:** the crash-dump retention, the Sales Brain upload gate, and the shadow-copy
  deletion — all tested only.

### The gaps I would name before a tag

1. **No packaged-build walk covers M37.** M36's proposal already owed one for `d9d524d`; M37 adds
   six changed copy surfaces, a new Settings card, and a new button on the call detail screen. All
   of my driving was against the **dev** build. The M36 recommendation stands and grows: one walk on
   the clean VM from an installer built out of a clean worktree of the merged `main`.
2. **The HUD has still never been on a real call.** Carried from M36. The founder's observation is
   still owed; protocol in `docs/M36-hud-observation-protocol.md`.
3. **BUG-234 ships unfixed** — every structured feature asks for a tool call where structured output
   is the guaranteed path. It is not a regression (it has always been this way) and it is not a
   release blocker, but it is the reason a user on a free tier sees features fail intermittently,
   and it will make this release look less reliable than its code is.

---

## The order I would take

1. **Decide the three copy sites** — approve round five's drafts, or defer them to 1.11.1 knowingly.
2. Merge the branch to `main` (fast-forward).
3. `npm ci` from `main`'s lockfile in a clean worktree; run the gate there; let CI run on the merge.
4. Build the installer from that worktree and **walk it on the VM**: sign in, Live + mic, Settings →
   Privacy & data (read the new card), Settings → Notes & summaries (the backfill offer renders and
   the count is right), open a call and press Generate title.
5. Tag **1.11.0**, `workflow_dispatch`, rollout **10**.
6. One clean day, then rollout **100**.

Steps 1, 5 and 6 are the founder's. I can do 2, 3 and 4 on the word.
