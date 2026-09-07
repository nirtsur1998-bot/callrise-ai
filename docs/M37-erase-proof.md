# Proving the claim: "a user can erase what this app uploaded, and the app no longer says anything false about where their data lives"

**Driven 2026-09-07, 12:45–13:20 local, on the founder's own profile and the live
Supabase project.** Every cloud figure below was read from the server by an instrument
that shares no code with the app's backup module. Screenshots are hashed in
`C:\Users\User\Desktop\callrise-proof\MANIFEST.txt`.

**The verdict, first: the first half of the claim holds. The second half does not yet.**
A user can erase what the app uploaded — proven twice, on two different tables, through
the app's own switches, verified against the server. But the app still says four false
things about where their data lives, and only three of the seven were in the strings
approved for this release.

---

## Preconditions, before anything

| Check | Result |
|---|---|
| Snapshot before anything that deletes | `memory-pre-five-front-proof-2026-09-07T09-58-38-006Z.db`, 73 memories, source and snapshot digests identical, `integrity_check ok` |
| Running app is my build (renderer) | Read `settings-nav.ts` **out of the running renderer** over CDP: it returns the new sentence, ending "unless you turn that off in Settings → Privacy & data" |
| Running app is my build (main) | `out/main/index.js`, built 13:04 from `4ea565e`: `scrubSalesBrainDb` ×2, `no scrub branch for sync scope key` ×1, `backup_rise_conversations` ×3 |
| One writer | 8 electron processes, all from `C:\Users\User\Desktop\callrise-ai`, one window |

**I restarted the dev app**, at 13:05, to add `--remoteDebuggingPort 9222`. Without a
debug port there is no way to read the app's real DOM or take a screenshot tied to a
state read, and the alternative was to reason about what the code implies. That is the
one thing you said not to do. The app is running now, restored to your settings.

---

## The copy, before the fronts

Three strings committed as approved (`0fe1999`), with **one factual correction** to the
words themselves.

The approved sentence sent the user to **"Settings → Backup"**. There is no page called
Backup. The toggles live on **Privacy & data**, in a card headed "Cloud backup". The
repo's own `settings-paths-in-copy` guard caught it, went red on all three strings and
named each. Directions to a page that does not exist are the same class of falsehood
this release exists to remove, so the destination is now the page's real name.

Everything else is your text, unchanged.

---

## Front 1 — the erase, end to end, on the running app

**Proved.** Read from the server at each step, never from the app's own report.

| Time (UTC) | `sales-brain` bucket, read from Supabase |
|---|---|
| 10:02:53 | 1 object — `memory.db`, **1,736,704 bytes**, updated 10:02:20 |
| 10:08:08 | **0 objects** |
| 10:09:23 | 1 object — `memory.db`, **1,736,704 bytes** |

**How.** Real mouse clicks at the element's centre, on the switch identified by its own
row label "Sales Brain memories" — never by index. After the click, `aria-checked` went
`true → false` **and** `settings.get()` returned `salesBrain: false`. State read after
every action, and asserted to have *changed*.

Screenshots: `F1-01-privacy-page-before.png`, `F1-02-toggled-off.png`,
`F1-03-erased.png`, `F1-04-restored.png`.

**The control that matters.** Turning it back on restored the object, so the
disappearance was a deletion and not a broken upload.

**The local store was untouched.** Re-snapshotted after the cycle: 73 memories, content
digest `a80477da…` — byte-identical to the pre-test snapshot.

**Not proved:** that the erase works when the app is offline at the moment of the toggle,
or that a scrub queued and never drained is surfaced to the user. See front 3.

---

## Front 2 — Rise conversations, proven independently

**Proved.** Different table, different policy, different code path.

There were **zero** rows to erase, and the toggle was already off, so the cycle had to be
created before it could be broken: 14 Rise threads exist locally.

| Time (UTC) | `backup_rise_conversations`, rows for this user |
|---|---|
| 10:10:53 | **14** (toggle on, sync) |
| 10:11:35 | **0** (toggle off, sync) |

At 10:11:35 the `sales-brain` bucket still held its object — so the erase was scoped to
the key that was toggled, not a blanket wipe.

Screenshot: `F2-01-rise-on.png`.

**Not proved:** that a Rise thread created *after* the toggle goes off never reaches the
server. Only that everything already there is removed.

---

## Front 3 — the failure directions

Three sub-claims. **Two hold. One does not, and it is the important one.**

### (a) A scrub key with no branch throws rather than reporting success — HOLDS

Driven for real, not asserted from source. `notARealScrubKey` was written into the live
`backup-pending-scrubs.json`, then Sync now was pressed. The push ran (`lastPushAt`
advanced to 10:14:39) and the queue afterwards still read
`{"keys":["notARealScrubKey"]}`. The key was not written out as though it had succeeded.

**But the user is never told.** `lastPushError` was `null` throughout. The catch around
each scrub logs to the console and re-queues; it does not call `reportBackupStep`, so
nothing reaches the Backup card. A user whose erase fails on every push sees "Backed up
just now" forever. That is a real gap and it is not what the code comment claims
("surfaces it as a failed step").

### (c) An object from an older build in the prefix is taken — HOLDS

An object was planted at `<userId>/sales-brain-v1.sqlite`, a name this build never
writes. The bucket then held two objects. One toggle-off and sync later it held **zero**.
The list-and-remove takes the whole prefix, which is the behaviour that stops an older
build's file surviving an erase forever.

### (b) A delete refused by RLS leaves the key queued — DOES NOT HOLD IN GENERAL

This is the finding of the night after the copy.

A `DELETE` that row-level security filters down to nothing returns **HTTP 200 with an
empty body and no error**. Measured on the live project against three tables:

```
backup_rise_conversations   status 200   rows [] 
backup_knowledge            status 200   rows []
backup_contacts             status 200   rows []
```

The drain's check is `if (error) throw new Error(error.message)`. It cannot tell "deleted
everything" from "deleted nothing, because a policy filtered it". The key is then cleared
from the queue and the erase is reported as done.

Today's code is *correct for the case we hit*, because before the migration
`backup_rise_conversations` had no delete **grant** either, and a missing grant does
produce an error. The guarantee that fails is the general one: **a table with the grant
and without the policy would scrub silently and successfully, deleting nothing.**

The fix is one line per branch — ask for the rows back and assert the delete removed what
it claimed, or re-count after. I have not made it: it is a change to the safety path and
you have not seen it.

---

## Front 4 — the copy on screen, all three sites, both themes

**Proved for the three strings. The front as a whole comes back short, and this is the
part to read.**

All three render exactly as committed, confirmed by reading the DOM text and by
screenshot, in both themes:

| Site | Where | Light | Dark |
|---|---|---|---|
| 1 — the card | "What CallRise remembers" / "Sales Brain (Beta)" | `F4-01` | `F4-04` |
| 2 — legacy nav | preview off, "Sales Brain (Beta)" | `F4-02` | `F4-03` |
| 3 — new nav | preview on, page subtitle | `F4-01` | `F4-04` |

Site 2 only exists with the design preview OFF, so the preview was switched off and back
on to reach it. Both were restored, along with your light theme.

### Four false claims remain, and none is in the three you approved

**Found by sweeping the whole renderer for the vocabulary of the claim rather than for
the sentence already known — and one found only by driving the app.**

1. **`PrivacyNoticeCard.tsx`** — the first thing on the Privacy & data page:
   > "Your call recordings, transcripts, knowledge base, and app settings live only on
   > this device. The summary below shows what does back up to your account."

   Unconditional. Its doc comment calls it "a short, honest recap". **In the same
   screenshot** (`F1-03-erased.png`), 800 pixels below it, the same page says "Call
   recordings & transcripts sync is ON — your buyer conversations are stored in your
   cloud account, not just this device." Three of the four categories it names were
   syncing when it was read. This is the worst of the seven: it is the privacy page
   itself, and it contradicts its own page without scrolling.

2. **`MemoryCenterSection.tsx`** — "Runs entirely on your own device. Nothing is sent
   anywhere." Shown at the moment a user decides whether to turn the feature on.

3. **`activationSteps.ts`** — "Runs entirely on your own device", on the home
   activation checklist.

4. The above three plus the three now fixed makes six sites for one claim. A seventh
   sentence, in `BackupCard.tsx`, turned out to be **true** and is documented as such.

I have not touched any of them. Privacy copy is the one place you read the words
yourself, and you have not seen these. They are pinned in the gate so the debt is
visible rather than forgotten.

---

## Front 5 — the fake eighth category

**Proved, and it proved more than asked.**

Adding `voicemailDrafts: boolean` to `BackupSyncScope` produced four compiler errors
naming it, including the decisive one:

```
src/main/backup.ts(218,7): error TS2741: Property 'voicemailDrafts' is missing in type
  '{ ... }' but required in type 'Record<keyof BackupSyncScope, true>'.
```

So a new uploadable category cannot exist without being declared erasable.

Then the compiler was satisfied at all four sites — `SCRUB_KEY_SET`, `EMPTY_SYNC_SCOPE`,
`sanitizeSyncScope`, `mergeSyncScope` — and typecheck came back with **zero** errors,
while the key still had **no branch that deletes anything**. The type system cannot see
that. What caught it was the source-scanning test, by name:

```
× every scrub key has a real branch in drainPendingScrubs
  these keys are queued for scrubbing and have no branch that deletes anything —
  they would fall through and be marked as scrubbed: [ 'voicemailDrafts' ]
```

Two layers, and the gap between them is exactly where BUG-200's near-miss lived. All
edits reverted; `grep -rn voicemailDrafts src/` returns nothing.

---

## What I could not drive, stated plainly

- **A genuine RLS refusal against a table that has the grant.** Producing one means
  dropping a delete policy on the production database. That is yours to run, not mine.
  What I could do — and did — is measure what the server returns when RLS filters a
  delete to nothing, which is what makes the guarantee false.
- **The Supabase dashboard.** The Chrome extension was not connected, and the Chrome
  window that was open was showing an API-keys page, so I did not drive or screenshot it.
  I read the bucket through the Storage API instead, which is the same server and a more
  repeatable instrument.

## State when I finished

Restored and verified from the server at 10:15:52 UTC: sync scope identical to the
before-read (`salesBrain: true`, `riseConversations: false`, the rest unchanged),
`memory.db` back in the bucket at 1,736,704 bytes, Rise rows 0, planted object gone,
scrub queue empty, light theme, design preview on.
