# Bi-temporal contact facts — the design

**Prepared 2026-09-11 for the founder, who asked for "the design, not the direction": what gets
dated, what happens to existing rows, what an "as of" answer looks like, what breaks.** This is a
data-model change, so nothing here is built. It is sized to land *after* the M39 release, not in
it.

## Contents

- [The problem, in one record](#the-problem-in-one-record)
- [What gets dated](#what-gets-dated)
- [The shape](#the-shape)
- [The write path](#the-write-path)
- [Existing rows](#existing-rows)
- [What an "as of" answer looks like](#what-an-as-of-answer-looks-like)
- [What breaks](#what-breaks)
- [What this does not fix](#what-this-does-not-fix)
- [Decisions for the founder](#decisions-for-the-founder)
- [The tests it would ship with](#the-tests-it-would-ship-with)

---

## The problem, in one record

A contact is a flat record. Its fields hold a current value and nothing else — no date, no source,
no history. The client dossier reads eight of them and puts them at the front of every live cue as
**"Known facts"**, where a model reads them as true *now*.

On the founder's profile one contact's `personalNotes` says she *"was unable to go to the bank
today because the neighbour would not be back until 6 PM."* That was true on one day. It will be
background on every future call with her, forever, and nothing in the record can say otherwise.

`memory.db` already solved this for Sales Brain memories: every fact carries **event time** (when
it became true, and when it stopped) and **system time** (when the app learned it, and when it
noticed it had changed). Contacts have neither.

**Measured on the founder's profile, 2026-09-11:**

| | |
|---|---|
| contacts | 50 |
| contacts carrying **any** of the dossier's 8 facts | **5** |
| field values in the proposed dated set | **19** |
| per-field date, source, or history on any contact | **none** |
| distinct `updatedAt` values across all 50 contacts | **1** — `2026-09-10T17:37:47.699Z`, a sync restamp |
| contacts with dated `comments` (`createdAt` + `source`) | 14, holding 28 comments |

That last line matters twice: `updatedAt` cannot date anything, and the contact file already has
a working precedent for dated, sourced entries.

---

## What gets dated

**A field is dated when some consumer asserts it as current truth about the buyer's situation.**
Identity is not situation.

| Class | Fields | Why |
|---|---|---|
| **DATED** (10) | `title`, `decisionAuthority`, `budgetIndication`, `timeline`, `competitors`, `currentTooling`, `knownObjections`, `personalNotes`, `otherStakeholders`, `dealValue` | Each can be true in July and false in September. The first eight are exactly what the dossier renders. |
| **IDENTITY** | `name`, `email`, `phone*`, `company`, `cid`, `country`, `timezone`, `website`, `industry`, … | A changed email is a *correction*, not "was true then". Current value only. |
| **RECORD** | `id`, `createdAt`, `updatedAt`, `deleted`, `comments`, and the new history field | About the record, not the buyer. |

**Enforced by the compiler, the way `CONTACT_FIELD_RULES` already enforces egress:** a new
`CONTACT_TEMPORAL_RULES: { [K in keyof Required<Contact>]: 'DATED' | 'IDENTITY' | 'RECORD' }`.
Adding a contact field without deciding whether it is dated becomes a build error, not a stale
fact in a prompt six months later.

---

## The shape

**The flat fields stay, and stay authoritative for "now."** Every existing reader — the Contact
page, the prep brief, the assistant's tools, the dossier — keeps working with zero changes. One
field is added:

```ts
interface ContactFact {
  id: string                                // uuid — the merge key across devices
  field: DatedContactField                  // which of the 10
  value: string | number | null             // null = the rep cleared the field
  // EVENT time — when it was true in the world
  validFrom: string
  validFromSource: 'call' | 'stated' | 'approx'   // the SAME enum memory.db uses
  validUntil?: string                        // the superseder's validFrom; absent = still true
  // SYSTEM time — when the app knew
  recordedAt: string
  supersededBy?: string                      // id of the fact that closed this one
  // PROVENANCE
  source: 'user' | 'ai-accepted' | 'import'
  callId?: string                            // the call an accepted fact came from
  redacted?: true                            // see decision 2
}

interface Contact {
  // …every existing field, unchanged…
  factHistory?: ContactFact[]
}
```

Why it mirrors `memory.db` exactly rather than inventing its own rules: there should be one meaning
of "valid from" in this app. Two would mean the dossier's facts and the Sales Brain's memories
could disagree about the same buyer on the same day.

---

## The write path

Every write of a DATED field **appends a fact and closes the previous open one for that field**.
There are three writers today, and each produces a different, honest `validFrom`:

| Writer | Where | `validFrom` | `source` |
|---|---|---|---|
| The rep types it on the Contact page | `contacts:update` → `updateContact` | now | `approx` — "true since at least when we learned it" |
| The rep accepts a coaching-chat suggestion | `coachChat:applySuggestion` → `applyKycField` | **the call's `createdAt`** | `call` |
| The rep accepts a CRM-note suggestion | `crm-note-generator-ipc` → `applyKycField` | **the call's `createdAt`** | `call` |

The two AI paths already hold the call that produced the fact, so a budget heard on a July call is
dated to July even if the chip is clicked in September. That is the single largest improvement
this design makes, and the plumbing is one optional `evidence: { callId, at }` argument on
`applyKycField`.

**Closing a window follows `invalidateMemory` to the letter:** the old fact's `validUntil` is the
**new fact's `validFrom`**, not the moment of writing. A July fact superseded by information from a
September call closes in September.

**The current flat value is the open fact with the latest `validFrom`, not the latest
`recordedAt`.** If a rep types a budget today and then accepts an older suggestion from a July
call, the July fact enters history as already superseded — it must not overwrite what the rep
just typed.

---

## Existing rows

**No backfill, and no existing contact file is rewritten by the release.**

The alternative — synthesising an `approx` fact for each of the 19 existing values — has nothing
honest to date them with. `createdAt` is when the record was saved, not when the budget became
true. `updatedAt` is one restamp shared by all 50 contacts. A backfilled date would be, in the
founder's words about `appVersion`, *a lie with a timestamp.*

So an existing value with no history is read as **undated**: `validFrom` NULL, meaning "true since
at least when we learned it" — precisely how `memory.db`'s `validityClause` already treats a row the
backfill never reached. History for a field begins at its first write after the release.

**The cost, stated:** those 19 values stay undated until someone touches them.

---

## What an "as of" answer looks like

```ts
factsAsOf(contact: Contact, asOf: string): Record<DatedContactField, FactAsOf | null>

interface FactAsOf {
  value: string | number
  validFrom: string | null        // null = undated (a pre-release value)
  validFromSource: 'call' | 'stated' | 'approx' | null
  source: 'user' | 'ai-accepted' | 'import' | null
}
```

For each dated field: **the fact whose `[validFrom, validUntil)` contains `asOf`**, ties broken by
the latest `recordedAt`; failing that, the flat value as undated; failing that, null.

The dossier already passes `asOf` — the moment the call started — so it would render:

```
Known facts:
- Budget: $50k (since 2026-07-14, from a call)
- Uses today: Salesforce (since 2026-09-02)
- Personal: unable to go to the bank today… (noted 2026-08-21)
- Timeline: Q4                                    ← undated: a pre-release value
```

Absolute ISO days only — never "3 weeks ago" — so the cached prompt prefix stays byte-identical, the
rule every dossier line already obeys. And a dossier rebuilt for an **old** call shows what was true
**then**, which today it cannot.

---

## What breaks

In order of how badly.

### 1. An older build can erase history from the cloud — the `endedAt` class, again

Contacts sync as a JSON `payload` (`backup.ts`: `payload: contactBackupPayload(c)`), so no Supabase
schema change is needed. But an **older build** pulling a payload with `factHistory` drops the
unknown key when it sanitizes the record, and its next push **overwrites the cloud row without
it** — exactly how `endedAt` was deleted from 297 of 297 calls.

**And the server makes it stickier than it looks.** `backup_contacts` has a trigger
(`supabase/backup-schema.sql:55`) that **rejects any update whose `updated_at` is not newer than the
stored row's**. So once an old build has written a history-less row, a new-build device pushing its
unchanged record is refused — its history cannot get back into the cloud until its own
`updated_at` is newer. "It restores on the next push" is only true if something guarantees that.

**Handled by the merge in 2, plus one requirement that makes the restore real:** when an import's
union merge ends up holding facts the incoming row did not carry, the merge **bumps the local
`updatedAt`**, so the next push beats the trigger and the cloud copy regains the history. Pinned
with a test that reproduces the whole sequence — old build overwrites, new build pulls, new build
pushes, cloud row has history again. No device running the new build ever loses local history;
during a mixed-version window the *cloud* copy can go without it until that next push.

### 2. Sync is whole-record newest-wins, which drops facts

`importContact` compares `updatedAt` and replaces the whole record. Two devices each appending a
fact would lose the loser's fact entirely.

**Change:** on import, **union `factHistory` by fact `id`** — never drop a fact present locally —
re-derive every `validUntil`/`supersededBy` and every current DATED value from the merged
history, and keep newest-wins for IDENTITY fields only. If the merged history is larger than the
incoming row's, bump `updatedAt` (see 1 — otherwise the server trigger keeps refusing the
restore). Same principle as calls' `mergeSpeakerIdentities`: reconciled, not replaced. This also makes history immune to the
restamp that currently gives all 50 contacts one `updatedAt`.

### 3. Clearing a field would no longer remove the words

Today, a rep who deletes a personal note deletes it. With history, the old text would survive in
`factHistory` — **and sync** — after the rep believes it is gone. This is the one that would break
a user's trust rather than a feature. See decision 2.

### 4. Exhaustive tables go red, correctly

`CONTACT_FIELD_RULES` must classify `factHistory` (proposed `SYNCED`, the same toggle as the rest of
the contact), and the renderer's duplicate `Contact` type gains the optional field. Both are
compile errors until done, which is the point of those tables.

### 5. Size

Unbounded history on a field edited weekly grows forever. **Cap at 20 facts per field**, dropping
the oldest *closed* fact first; an open fact is never dropped.

### 6. Tombstones and erase

A deleted contact keeps no history (the same rule calls apply to local-only fields on a
tombstone), and "Forget everything" erases it with the contact. Both need a test, because history is
exactly the kind of field an erase path written before it existed would miss.

---

## What this does not fix

- **It dates a fact; it does not decide the fact is stale.** The model sees "noted 2026-08-21" and
  can weigh it. Nothing expires. Expiry rules per field would be a separate decision, and a
  guessed one is worse than a visible date.
- **The 19 existing values stay undated.**
- **The dossier gets slightly longer.** About 14 characters per dated line, inside a 1,200-character
  cap. On the 3 contacts that already hit the cap, one lower-ranked line may drop.

---

## Decisions for the founder

1. **Scope** — the 10 dated fields above, identity fields undated. *Recommended.*
2. **Clearing a field redacts history, or keeps it.** Recommended: **redact** — keep the dates and
   the source, remove the words (`value: null`, `redacted: true`). "What was true when" survives;
   what the rep deleted does not. Strip, not scrub.
3. **No backfill** of the 19 existing values. *Recommended*, and consistent with the `appVersion`
   ruling.
4. **History syncs** with the contact, under the existing contacts toggle. *Recommended.*

---

## The tests it would ship with

- `factsAsOf`: an open fact, a closed fact, a gap, a NULL-`validFrom` fallback, and a tie on
  `validFrom` broken by `recordedAt`.
- A write closes the previous window at the **new fact's `validFrom`**, not at now.
- An accepted AI fact is dated to its **call**, not to the click.
- The current value is the **latest `validFrom`**, not the latest write.
- Two-device union merge, including the case where an **older build overwrote the cloud row**.
- A merge that restores history **bumps `updatedAt`**, so the next push is newer than the stored
  row and the server's newest-wins trigger accepts it.
- An unclassified contact field fails to compile.
- Clearing a field redacts every prior value of that field in history.
- A tombstone and "Forget everything" both remove history.
- The dossier stays byte-identical across two assemblies with dated facts in it.
