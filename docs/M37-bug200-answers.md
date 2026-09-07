# BUG-200 — the founder's three questions, answered from evidence

**2026-09-07.** Nothing has been changed. These are answers, and the third one found a second
instance the first did not.

---

## 1. Is it live for you right now?

**Yes. Your Sales Brain database has been uploading successfully, and a push completed at
06:47 this morning.**

The evidence, and the control that makes it mean something:

| What | Value |
|---|---|
| `backup-state.json` `lastPushAt` | **2026-09-07T06:47:56Z** (today), and **no `lastPushError`** |
| Your `syncScope.salesBrain` | **`true`** |
| Local `memory.db` | present, 1.68 MB, 73 memories |
| `salesBrainUpload` failures in telemetry | **7 in total, all between 2 and 5 September** (502, 520, five StorageUnknownError) |
| Failures since 2026-09-05T03:10 | **none** |

`reportBackupStep` only fires on **failure** — a successful upload writes nothing anywhere. So
"no failures" is the only success signal available, and on its own it is worthless if telemetry
simply stopped. **The control:** 11 telemetry batches were sent after that last failure, every one
status 200, up to 2026-09-06T20:47, and there are **zero backup step failures of any kind** in that
window. Telemetry was working and reporting nothing wrong.

Combined with pushes running on launch, on sign-in and every ten minutes, the reading is that the
uploads have been succeeding for roughly two days and continue to.

**What I did not do, and why.** The only definitive proof is listing the bucket, which needs your
Supabase credentials and is a request to your backend on your behalf. That is yours to run, not
mine. The exact check, in the Supabase dashboard for the CallRise project:

> **Storage → `sales-brain` bucket → open the folder named with your user id.** If `memory.db` is
> there, its size and "last modified" tell you when. That is the answer with no inference in it.

The seven failures in early September also settle a side question: those were 502/520/StorageUnknownError,
**never "Bucket not found"**. The bucket exists. This is not the dormant BUG-087 gap.

---

## 2. What is the smallest honest change?

**Your instinct is right, and the reason is stronger than "cheaper": stopping the upload does not
actually work for you.**

**Taking the copy down** is three string edits — `SalesBrainSection.tsx:174` and both design
variants in `settings-nav.ts` (`:199`, `:418`). No behaviour change, no migration, no risk. It
takes effect for every user, new and existing, the moment it ships.

**Stopping the upload is two characters and reaches almost nobody.** `EMPTY_SYNC_SCOPE` only
applies when there is **no settings file at all** — a genuinely fresh install. Once a settings file
exists, `sanitizeSyncScope` governs, and it reads the **stored** value (`v.salesBrain === true`).
**Your stored value is `true`.** So flipping the default would leave your upload running, and
everyone else's who already has the app. Reaching existing installs needs an explicit
override-with-notice migration — the same machinery BUG-115 and the auto-update default both
needed. That is real work, not a two-character change.

So the order is forced by the mechanics rather than by taste:

1. **Now: the copy comes down.** It is the only change that is both immediate and complete. A false
   privacy claim is worse than an absent one, and this is the one edit that stops the app asserting
   it to anybody.
2. **Then: the deletion path**, which does not exist at all (see §3). Until it does, "turn it off"
   cannot be offered honestly, because off does not remove anything.
3. **Then: the default and the migration**, with a notice, so existing users are told rather than
   silently switched.
4. **Then: encryption.** It is uploaded as raw bytes today (`backup.ts:587-591`, no dirty check,
   the whole file every cycle).

**One thing to decide with step 1:** the honest replacement sentence has to say where it goes. Not
"never uploaded", and not silence either — something like *"stored on your device, and included in
your cloud backup unless you turn that off in Settings."*

---

## 3. What else uploads that you do not know about?

**Two of the seven sync keys upload with no removal path, and they are exactly the two that default
ON.** I enumerated all seven rather than looking for more of the same.

| scope key | uploads | default | in `SCRUB_KEYS` | delete branch in `drainPendingScrubs` | removable? |
|---|---|---|---|---|---|
| `transcripts` | call rows, objection queue | off | yes | yes | yes |
| `attachments` | document blobs | off | yes | yes | yes |
| `knowledgeBase` | knowledge rows | off | yes | yes | yes |
| `contacts` | contacts, deals, stages | off | yes | yes | yes |
| `settingsPersonalization` | settings row | off | yes | yes | yes |
| **`salesBrain`** | **the whole `memory.db`** | **ON** | **no** | **no** | **NO** |
| **`riseConversations`** | **your Rise chat threads** | **ON** | **no** | **no** | **NO — and worse** |

### The second instance: `riseConversations`

This is BUG-200's exact shape again, and the contradiction is inside one file. The scope field's own
doc comment (`app-settings.ts:606-614`) reads, verbatim:

> "**OFF by default like every other category here**, and deliberately so even though the founder
> asked for the capability directly: a chat log is at least as sensitive as the transcripts sitting
> one line above, which are also opt-in. Turning it on for existing installs on upgrade would start
> uploading conversation content that nobody agreed to upload."

Three hundred lines below, `EMPTY_SYNC_SCOPE` sets `riseConversations: true`.

**And it is worse than the Sales Brain case in one respect.** `backup_rise_conversations` has
`select`, `insert` and `update` policies and **no delete policy at all**
(`supabase/2026-09-rise-conversations-backup.sql`). So even a correctly written scrub branch would
be refused by row-level security. The data cannot be removed by the application under any
implementation, without a schema change on the backend.

**You are not affected by this one.** Your stored `riseConversations` is `false`. A fresh install
is affected; you have 14 Rise threads locally, so on a new machine they would go up.

### Why your recommended fix would have shipped a hollow green

`drainPendingScrubs` is an `if / else if` chain with branches for exactly those five keys and **no
`else`**. A `salesBrain` key added to `SCRUB_KEYS` would fall through every branch, throw nothing,
not be added to `remaining`, and be written out of the pending file **as though its scrub had
succeeded**. The Backup card would show the scrub done. Nothing would have been deleted.

So the deletion work is: a delete branch for `salesBrain` (a Storage `remove`, not a table delete),
a delete branch **and a backend delete policy** for `riseConversations`, and **an `else` that
throws** so the next key someone adds without a branch fails loudly instead of silently.

---

## What I did not establish

- Whether `memory.db` is in the bucket right now. That needs your dashboard, above.
- Whether the seven early-September failures mean some pushes never landed; they were transient
  gateway errors and later pushes would have overwritten regardless.
- What is in `backup_rise_conversations` for any user other than you.
- Whether any other user of the app is affected, since I can only read this machine.
