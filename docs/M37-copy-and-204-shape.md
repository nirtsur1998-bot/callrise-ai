# Your three items: the copy, the BUG-204 shape, the species count

**2026-09-07.** Nothing in here is committed to the app's copy. Every string below is a draft
awaiting your word, same as before.

---

## 0. Read this first: all four of my drafts were wrong

I sent you four drafts and said one existing string was fine. An adversarial pass against the
codebase refuted **all five**. The worst of it is my own sentence, which I had verified myself
before sending:

> "Your call audio never leaves this device."

**Call audio leaves this device on every call.** It is streamed frame by frame to Deepgram over a
websocket, both channels, the rep's and the buyer's. That is not a bug, it is the product: there is
no local transcription anywhere in the tree. I searched the backup paths, found no audio upload,
and wrote "any path". The app already tells users the truth about this in one place, in the
assistant view: "Audio is sent to Deepgram to be transcribed."

That is the same failure I have now made twice this week in the same shape: **I searched the
container I was thinking about instead of the container the claim named.** The first time it was
"never leaves" versus "never leave". This time it was the backup module versus the device.

**So the count is not seven sites. It is ten, plus four bugs that are not copy at all.**

---

## 1. The copy

### The four you already knew about

| Site | Status |
|---|---|
| `PrivacyNoticeCard.tsx` — the Privacy & data opening card | pinned, draft below |
| `MemoryCenterSection.tsx` — the off empty state | pinned, draft below |
| `activationSteps.ts` — home checklist | pinned, draft below |
| `BackupCard.tsx` — "never leave this computer" | **was recorded as TRUE. It is false.** Draft below |

**Why BackupCard is false, since I told you it was fine.** A Sales Brain memory's evidence is a
verbatim 400-character span of the transcript. `memory.db` uploads to the `sales-brain` bucket.
Sales Brain sync defaults on. So with Sales Brain switched on, word-for-word transcript text leaves
the computer while that sentence says it does not. My allowlist entry reasoned about the toggle
whose name matched and stopped there.

### Three more false sites

**`CoachingView.tsx`** — shown directly above the "Turn on skill tracking" button, so it is read at
the moment of consent:

> "Uses your existing coaching results — no extra AI calls, nothing new leaves your device."

Turning skill tracking on adds four fields to the call's coaching record, and the full backup
payload spreads that record wholesale. With transcripts sync on, which it is for you, new data does
leave the device.

**`AccountMigrationNoticeCard.tsx`** — "Your calls, transcripts, contacts and Sales Brain live on
this computer and are completely unaffected." Call titles, summaries and coaching scores are in the
always-synced set. Transcripts sync is on. Sales Brain defaults on.

**`TelemetrySection.tsx`** — "Nothing has been sent from this computer." The button immediately
beside it deletes the local record of what was sent. Press it after events have gone out and the
page asserts nothing ever left. The sibling branch of the same component is careful and honest.

**`Done.tsx`, the last screen of onboarding** — "optional cloud backup for your calls, tasks, and
calendar." Those three are precisely the ones that are **not** optional. Tasks, calendar events, and
call titles/summaries/coaching scores are the always-synced set, and there is no master backup
switch anywhere. The one sentence that tells a brand-new user what goes to the cloud names the
mandatory three as the optional ones.

### The drafts

Each one is now written against what the code actually does, including Deepgram.

**A. `PrivacyNoticeCard.tsx`**

> Your call audio goes to Deepgram to be turned into text, and your transcripts go to the AI
> provider you set up in Settings. Your Google and Outlook sign-ins stay on this device. Below is
> what backs up to your account, what is on by default, and what you can switch off.

**B. `MemoryCenterSection.tsx`**

> Facts are extracted through your own connected AI provider and stored on your device. They are
> included in your CallRise backup unless you turn off both Sales Brain memories and Rise
> conversations in Settings → Privacy & data.

The "both" is load-bearing. Rise conversations carry Sales Brain facts verbatim inside citation
labels, so switching off only the Sales Brain leaves those facts in your account with no way to
remove them.

**C. `activationSteps.ts`**

> Sales Brain remembers who you are, how you sell, and each client, so coaching and prep stop
> starting from scratch every time. It is stored on your device, and if you sign in it goes into
> your CallRise backup unless you turn that off. What it remembers is sent to your AI provider when
> it works on your calls.

**D. `BackupCard.tsx`** — the one I wrongly said needed no change:

> With this off, your call transcripts are not backed up to your account. Two things still leave
> this computer: while a call is running, its audio goes to our transcription provider, and short
> word-for-word quotes from your calls travel inside Sales Brain memories, which is switched on by
> default above.

**E, F, G** — `CoachingView`, `AccountMigrationNoticeCard`, `TelemetrySection` and `Done.tsx` need
rewrites too. I have not drafted those four, because A to D are the ones that make a privacy
promise and I would rather you approved a small set precisely than a large set quickly. Say the
word and I will draft the rest.

---

## 2. BUG-204 — the fix shape

Three shapes were designed independently and judged by two separate lenses, safety and durability.
Both lenses ranked the same one first.

### The shape: prove empty

For each scrub: **count before, delete with the count header, count after. The key leaves the
queue only when `after === 0`.**

The one substitution that makes your instruction survive contact with reality: the pass rule is
`after === 0`, **not** "the count moved".

- `before === 0 && after === 0` is a **success**, called *already-empty*. It is the common case.
  The literal "fail if the count did not move" would re-queue it forever, and for the `transcripts`
  key that means rewriting and re-uploading the user's entire call history on every push, which is
  the exact loop the existing code was written to avoid.
- `after === 0` is also strictly stronger than "moved": before 5, after 2 has moved and is not
  erased.

**`before` still earns its place**, for a reason I would not have predicted. With three numbers you
can tell *RLS filtered the delete* (`deleted === 0`, the BUG-204 fingerprint) from *the delete
worked and another device re-added rows* (`deleted > 0`). With two you cannot, and you would tell a
user their data was not deleted when the truth is that their other laptop is still syncing. That
false alarm is its own failure.

**`count === null` is a third state, never zero.** If the count header is missing, the outcome is
*unverifiable* and the key stays queued. After N consecutive unverifiable attempts it stops
re-queuing and records `unverifiable-gave-up`, keeping the warning on screen. That bound needs your
explicit yes or no: without it, a stuck `transcripts` key re-uploads the whole call history forever.

**Storage gets the same three numbers from different primitives.** The first page of the existing
`list` loop is the before-count, free. `remove()` returns the objects it actually deleted, which is
the delete-count. Then one `list(userId, {limit: 1})` after the loop drains is the after-count. That
last call is the assertion the current code never makes — today the loop breaks and never re-lists.
And Storage has BUG-204's exact twin: `remove` needs both delete and select permission, so a bucket
with our new delete policy and a broken select policy returns 200 with an empty array and no error.

**Cost:** one extra request per table scrub, none for the delete count (a header on a request
already being sent), one extra list per bucket.

**The trap one of the three shapes walked into, worth recording.** Its headline was
`.delete().select('id')`. `backup_settings` and `backup_deal_stages` are both `primary key
(user_id)` with **no `id` column**, so PostgREST answers 42703, the existing `if (error) throw`
fires, and two currently-working erases become permanently failing scrubs — on the privacy path, in
the name of fixing it. I hit the same wall myself two hours ago when my cloud reader asked for
`select=id` on `backup_settings`.

**What none of it buys, stated because it should be:** every count reads through the same token and
the same `user_id = eq.me` predicate as the delete. A blind SELECT policy reads zero before and zero
after, and every possible shape retires the key confidently. That is a real floor and no design
here clears it.

**And the shape is not proven until it runs against the live project with a delete policy
deliberately dropped, watched go red, and restored.** That is your rule 5 and it is your database,
so it is your step, not mine.

### BUG-203, built with it

`BackupState` already keeps push and pull errors in separate fields, and the comment says why: one
shared field lets whichever ran second clear the other's failure. A scrub failure is the third
member of that family. So:

- three additive fields: `pendingScrubs`, `lastScrubError`, `lastScrubErrorAt`;
- one line in the existing catch: `reportBackupStep('scrub.' + key, err)`, which every other failing
  step in that file already calls and this one does not;
- the Backup card shows the pending-removal line **instead of** "Backed up just now" when a key has
  failed twice, in the warning treatment the card already has. Twice, not once, so a single offline
  push does not alarm anyone.

`getStatus` needs no change; it spreads the whole state.

The red check is the reproduction: write a bogus key into the pending-scrubs file, press Sync now,
and the card must say so.

---

## 3. The species numbers: 87

Not two contested numbers. **Seven**: 1, 18, 19, 35, 36, 76, 77. All are now resolved, with a
**NUMBERING REGISTER** at the top of the taxonomy recording each one, its canonical meaning, what
else claimed it, and how the order was established.

**Canonical count: 87 species**, numbered 1 to 88 with **10 never allocated**, plus three lettered
sub-entries. No number is defined twice. Number 10 is left unallocated rather than reused.

The two that mattered most were being **cited from production source while existing nowhere as a
definition**:

| Cited as | From | Now |
|---|---|---|
| species 76, "the isolation of a sandbox is decided by what it can REACH" | `sandbox-profile.ts` | **species 87**, now defined |
| species 77, "a heading is a claim" | `tracker-status.mjs`, its test, the verification README | **species 88**, now defined |

The rest were mis-citations rather than rival mints: two places cited species 1 meaning 5 and 48;
the Milestone Tracker recorded a whole session's mints shifted by one; and the closing-principles
list ran 1 to 17 then 18, 18 with no 19, which is why "principle 18" and "species 18" both existed
and neither was wrong.

**The pattern that caused six of the seven, and the rule that follows.** A species gets minted
inside a session, cited immediately from a source comment, and only sometimes written into the
taxonomy. **A number is not minted until it has a definition in the taxonomy file.** Cite the words
as well as the number until it does.

---

## 4. Four things that are not copy bugs

Found by the same sweep. Two of them are worse than the copy.

**A deletion that undoes itself.** "Forget EVERYTHING Sales Brain has learned" says "This cannot be
undone." It is undone automatically. The local store is emptied; the next push refuses to upload an
empty brain over an existing cloud copy, deliberately, so the full `memory.db` stays in the bucket;
the next restore sees zero local rows and downloads it back. The user's irreversible deletion is
reversed by the sync.

**A Rise thread deletion that does not stick.** Deleting a conversation unlinks the local file with
no tombstone. The push writes every surviving conversation with `deleted: false`, and the restore
re-imports the cloud row because nothing marks it deleted. The thread reappears on the same machine.
The code's own doc comment says this happens, while the dialog says "This cannot be undone."

**Onboarding names the mandatory categories as the optional ones**, on the last screen before a
user's first call.

**Your Google account address leaves the device in the always-on push, with no toggle.** A linked
event's `provider` field is `google:<your primary calendar id>`, which is your Google address. The
event payload strips only the `sync` block, so that address is upserted into `backup_events` every
ten minutes as part of the core push that has no switch.

All four are logged.
