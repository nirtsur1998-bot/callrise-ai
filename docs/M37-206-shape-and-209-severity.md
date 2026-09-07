# BUG-206's fix shape, BUG-209's severity, and why the copy still is not right

**2026-09-07.** Nothing here is built. 204, 203 and 207 are built and committed; this is the
material you asked to see before 206, plus the severity you asked for and one thing I found while
checking it.

---

## 1. BUG-206 — the fix shape

### Your crux, answered

You asked how I distinguish "empty because it failed" from "empty because the user erased it".

**The answer is that the fix never makes that distinction, and that is the point rather than a
dodge.** Both designs stop uploading emptiness altogether.

The guard is not loosened. It is **tightened**: a `memory.db` with zero memory rows is never
uploaded, marker or no marker. An erasure never needed an upload — what the user asked for is that
the cloud copy stop existing, which is a **delete**, and this file now has a proven, verified delete
for exactly that bucket, because BUG-204 just built one.

So the guard's question, "this file has zero rows, is it safe to overwrite the cloud with it?", is
never asked in the erase case. Today the code asks a question it cannot answer, because an absence
carries no reason.

### Where the reason is stored

`forgetEverything` is already one SQLite transaction over three tables. The fix adds a fourth
statement to that same transaction: an **erasure receipt** written into `memory_meta`, a key-value
table migration 006 already created. No new migration.

Because the receipt joins the wipe's own transaction, "rows deleted with no receipt" and "receipt
with rows still there" are both unreachable by a crash. Either both committed or neither did.

**A corrupted store cannot forge one.** The handler needs a live database handle before it can run
the wipe, so a husk, a torn file or a half-migrated store never ran it and never carries a receipt.
Every failure direction lands on "keep the cloud copy". Your existing protection is byte-for-byte
intact for every not-on-purpose empty.

### The rule that makes more than one copy of the receipt safe

> Only the in-database receipt can authorise a destructive cloud action, and it is physically
> inseparable from the deletion it certifies. Every other record can only make the app **more**
> conservative: refuse an upload, withhold a restore, raise a question. None of them can authorise
> an upload, an overwrite or a delete.

### Four corrections the panel made to the winning shape

1. **Write the tombstone BEFORE deleting the brain, not after.** The winner had it backwards and
   called it a constraint. A crash in that window leaves an empty bucket with no record, which is
   the ambiguous state the whole design exists to abolish.
2. **Do not reuse `eraseStoragePrefixProven` for this.** Its confirming list treats any surviving
   object as failure, and the tombstone lives under the same prefix, so reuse throws "survivors"
   forever and lights the Backup card permanently. It needs a sibling that excludes the tombstone.
3. **Put the check where the damage happens.** The runner-up put its second-device protection in the
   restore path. Most syncs are push-only, so a second device that learns one memory would upload
   its pre-erasure brain over the tombstone without ever pulling. That is BUG-206's own shape
   reappearing inside its fix.
4. **There is an existing test forbidding the blanket block.** `salesbrain-husk-guards.test.ts`
   asserts "still uploads an empty DB when the cloud has nothing to lose", with the message "the
   refusal must not become a blanket block". Tightening to an absolute invariant reverses a recorded
   decision, so it goes to you as a decision rather than in as a tightening. **I need your yes or no
   on that one.**

### The thing none of the designs handled, and it is the same species again

**The app keeps a complete pre-erasure copy on the same disk and restores it automatically.**

`db.ts` writes `memory.db.pre-migration-backup` before every schema migration and, when a migration
fails, restores it on top. Compose it: you press Forget everything and get a receipt. The
pre-migration backup, taken before that receipt existed, still holds every memory. A later update
ships a migration that fails on your machine. The app restores that file on top by itself. The live
database now has rows and **no receipt**, because the receipt was in the file that was overwritten.
Every guard in every design then reads correctly and permits the upload.

Three individually correct behaviours composing into the reversal of the same promise, reached by a
path no design closes, on one machine, with no second device.

**Minimum fix:** `forgetEverything` must also delete the local pre-migration backup and the
`.local-unreadable-*` asides, which are also full of memories and also never deleted. Otherwise
"Forget EVERYTHING" leaves a complete copy on disk that the app itself is willing to reinstate.

---

## 2. BUG-209 — severity is LOW, and I checked rather than assumed

**It is your address in your own backup. No other CallRise user can read it.**

Two reviewers disagreed, so I probed the live project myself, read-only, with the shipped anon key
and no user session, which is the real threat model because that key is extractable from the
packaged app.

| Probe | Result |
|---|---|
| Every backup table, anon key, no session | **200 with zero rows** |
| `notification_channels`, `alert_deliveries` | 404, not in the schema |
| `claim_due_deliveries`, `derive_meeting_alerts`, `mark_delivery_sent` | 404, do not exist |
| `server_now` | exists, returns a timestamp, harmless |

Zero rows rather than everyone's rows is the empirical proof that row-level security is enabled and
enforced. The dissenting reviewer's HIGH rating rested on two server-side functions that read every
user's events; **those are not deployed on this project.** That matches the alerts feature sitting
behind its deployment flag.

So it is readable by you, by whoever holds the service-role key, which is you, and by Supabase as
the host. That is the first of your two cases, not the second.

**Worth fixing anyway, cheaply:** strip `provider` to the bare provider name before upload. The
field's consumers need to know *which* provider and whether ids match, not the address.

**What else rides the always-on push with no toggle**, since you asked for the rest and not just the
field you named:

- every calendar event's **title and free-text notes**
- the whole task object, including `clientName`, a free-text person or company. Someone else's name,
  arguably more sensitive than your own address
- call titles, the **AI summary of the conversation**, coaching scores and comments, and resolved
  buyer names

Transcripts and evidence quotes are correctly stripped from the call payload by default.

---

## 3. New: BUG-210, and it is not live

The alerts schema defines **six SECURITY DEFINER functions and revokes execute on none of them.**
Postgres grants execute to PUBLIC by default, so deploying that file as written would make them
callable with the shipped anon key and no user session. One of them returns other users' account
ids, notification addresses and meeting times.

**It is not live: I verified the functions do not exist on the project.** But the file is sitting
there ready to run, and the pattern for doing it right is already in this repo — the telemetry
schema carefully revokes execute from anon and public on its own definer functions. The newer file
did not copy it.

---

## 4. New: BUG-211 — the "default ON" story is narrower than we have been saying

`sanitizeSyncScope` resolves any key that is not literally `true` in the stored settings file to
**false**, and the defaults object is only used when there is no file at all.

So an install that existed before those two keys were added gets **salesBrain and riseConversations
OFF**, not on. "Defaults ON" applies to a genuinely fresh profile, and to yours because your file
carries the key. That narrows BUG-200's blast radius and I would rather correct it than let a
convenient number stand.

---

## 5. The copy: five drafts, five refutations, and I think the words are not the problem

Round two came back **MISLEADING on four and FALSE on one**. Not one of them survived.

One fact breaks almost every sentence: **a Sales Brain memory's evidence is a verbatim
400-character span of the transcript, `memory.db` uploads by default, and none of it is governed by
the "Call recordings & transcripts" toggle.** So a user who deliberately switches transcript backup
off, and leaves Sales Brain alone because the copy told them it holds who they are and how they
sell, still has word-for-word buyer speech in their cloud account.

Every honest sentence has to carry that, and it makes every sentence long.

**So my recommendation is a question rather than a draft.** At some point the true sentence is so
complicated that the behaviour is the problem and not the wording. Two changes would make the copy
short and true:

1. **Gate the Sales Brain upload on the transcripts toggle**, the way the objection queue already
   is, on exactly the same reasoning: an evidence quote is the buyer's words verbatim, which is the
   category that toggle already governs.
2. **Or stop storing verbatim spans as evidence** and store a reference plus a paraphrase.

Either makes "your transcripts stay on this device unless you turn that on" simply true, which is
the sentence the app has been trying and failing to say in seven places.

I have not drafted round three, because drafting against behaviour you may change would waste your
reading. Tell me which way you want to go and I will write the four sentences to match.
