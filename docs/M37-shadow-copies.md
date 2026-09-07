# "Check whether anything else writes a shadow copy that survives a wipe"

**2026-09-07.** Four independent sweeps plus a completeness critic told to find what the four
missed. **79 distinct artifacts: 5 critical, 18 high, 28 medium, 28 low.**

It is a family, not a fourth instance. Below are the families and the decisions each needs, because
fixing 79 things one at a time is how the list gets to 100.

**Two are already fixed and shipped in the branch**, both this evening: the pre-migration backup and
the import ledger. The rest are yours to rule on.

---

## What is fixed

**Every complete copy of the brain beside the live file.** `removeBrainShadowCopies` enumerates the
directory and deletes anything matching `memory.db.` — the three that exist today
(`.pre-migration-backup`, `.upload-snapshot`, `.local-unreadable-*`) and any a future change adds.
Naming the three would have repeated the original bug exactly.

The dot is the whole guard and it is load-bearing. `memory.db-wal` uses a hyphen, so the sidecars
are excluded by construction, and they must be: the deletes that just ran are sitting in the WAL
until SQLite checkpoints them. Deleting it would roll the erase back. The test red-checks that.

**The import ledger.** `backfill_attempts` holds no content, only which calls were processed. But
it is what makes a re-import skip calls, so after Forget everything a rebuild silently did nothing.
The user erased and could not get back to a working brain.

Found by asking which real tables the wipe leaves, after four sweeps had spent themselves on files.
Not in the exotic virtual-table shadows everyone expected — sqlite-vec does overwrite the vector
bytes on delete — but in a plain create-table two migrations along in the same schema.

---

## Family 1: verbatim buyer speech that outlives the record it came from

**This is the one that outranks the others**, because it makes a promise the product already made
false.

**Sales Brain memories survive the call they were mined from.** `deleteCall` promises "a deleted
call must not retain buyer words." A memory's evidence is a verbatim 400-character span stamped
with that call's id, and deleting the call removes nothing from the brain. The only thing that
would is the "don't learn from this call" toggle, which lives on a call you can no longer open.

**Conflict copies of the objection queue.** `<id>.conflict` files hold `objectionQuote` and
`responseQuote`, which the store's own header calls the buyer's words. Nothing removes them, and
the sync re-creates them on any later two-device disagreement.

**`transcription-debug.log`.** Raw buyer speech. The reason no sweep found the writer is worth more
than the file: **it is written by the shipped bundle, which is gitignored, so no audit of the app
repo can see it.** There is a whole class of userData writers invisible to a source review. That is
the fourth rule in CLAUDE.md, met again.

**Decision:** does deleting a call delete what it taught? The Rise dialog already says learned facts
stay and points at Settings. `deleteCall` says the opposite. Both cannot be right.

---

## Family 2: derived caches no deletion path knows about

**Prep briefs.** `prep-briefs/<sha256(eventId)>.json` holds the contact's name and title, the deal's
stage and value, personal notes, and a previous call's summary or transcript preview. **There is no
delete function for a prep brief anywhere in the repo.** Not one. Deleting the event, the call, the
contact or the deal removes nothing, and the filename is a truncated hash so you cannot find the
brief belonging to a record you just deleted.

**Job results.** `jobs-state.json` retains `resultData`, which for a CRM note is the generated note
and extracted facts. Retention is count-based and explicitly exempts entries holding unreviewed
output.

**Decision:** these are caches with no owner. Either a retention policy, or they join the companion
registry that deletion already walks.

---

## Family 3: crash dumps

`Crashpad/**/*.dmp`. The codebase states its own contents: "live transcript text, buyer speech,
contact and deal records, and any AI provider key currently in use."

**Nothing ever deletes them.** No age cap, no size cap, no sweep. The only code touching them counts
them for telemetry.

The file carries a long, correct, emphatic comment about **egress** — do not upload these — and
concludes "kept locally on purpose." The retention question was never asked next to it. So the
answer to "does a deleted call retain buyer words" is no, unless the app crashed during it, and then
yes, forever, under a filename no assertion could be written for.

**Decision:** an age cap and a purge on Forget everything. This is the cheapest large win on the
list.

---

## Family 4: conflict copies generally

`<id>.conflict` in knowledge, contacts, deals, events, Rise threads and the objection queue. These
are **deliberate** and surfaced in the Backup card, which is why they are the benign member of the
family — except that nothing deletes them after the user resolves the conflict, and the objection
queue ones hold verbatim quotes.

**Decision:** surfaced-and-kept is a reasonable design. Surfaced-and-kept-forever is probably not.

---

## What the critic checked and found clean, so nobody re-walks it

- **sqlite-vec shadow tables.** Four real backing tables no application code names. The delete path
  overwrites the vector bytes rather than un-flagging them, so there is no residual-embedding
  shadow. Established from the library's own error strings rather than by running it, and that
  limit is stated.
- **The FTS index** does not exist on your machine yet: your store is at schema 3 and the migration
  that creates it has never run. Worth knowing for later: nothing in the tree runs `optimize`,
  `VACUUM`, or a WAL checkpoint, so FTS delete markers will accumulate once it lands.
- **The Chromium HTTP cache.**

## And one modality nobody ran

**The Windows notification store.** Windows archives toast XML in its own database, and the alerts
path deliberately pushes the richest artifact in the product — the prep brief — into a toast. That
is outside the app's userData entirely and outside anything the app can delete.

---

## The pattern worth keeping

Every one of these was created for a good operational reason: safety before a risky operation, crash
recovery, an atomic write, a cache, a preserved conflict. None was careless. The deletion path
simply did not know the companion existed, because the companion was written by a different
subsystem for a different purpose.

**So the durable fix is not a list.** It is that every store declares its companions in one place
that deletion walks — the repo already has `RECORD_COMPANION_SUFFIXES` and `RECORD_DIR_NAMES` for
exactly this, and most of the findings above are things that never got added to it. Making that
registry the only way to write beside a record, and failing a test when a writer bypasses it, is the
change that stops the list growing.
