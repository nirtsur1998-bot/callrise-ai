# M37: what is done, and exactly what is left

**2026-09-08.** Branch `claude/m37-close-prepare-wedge-imagine`, pushed. Gate green at 391 files
and 3744 tests. **Nothing merged, nothing released.**

---

## Done: the SQL is run and verified

Run on production 2026-09-08 through the in-app browser, on the CallRise-AI project.

**The two conditions were met before Run.** The editor model was hashed and compared against text
derived mechanically from the committed file: sha256 `9e20a437…`, 3145 characters, identical. The
hash was re-checked immediately before pressing Run and still matched.

**BUG-213 is fixed, proven with the instrument that found it:**

| | Before | After |
|---|---|---|
| `GET /rest/v1/rpc/telemetry_prune`, shipped anon key, no session | `405 25006` — Postgres refusing the DELETE in a read-only transaction, so the permission check had PASSED | `401 42501 permission denied for function telemetry_prune` |

The run own verification select confirms `anon_can_execute = false` and an acl carrying only
postgres and service_role.

**BUG-210 stayed skipped, as designed.** Its eight alerts functions do not exist on this project,
so the guarded script announced the skip instead of aborting. Re-run the same file after deploying
alerts-schema.sql and that half applies.

**One correction to the file, made after the run.** Its verification note said every row must read
`false`. That is wrong: `telemetry_ingest_batch` legitimately reads `true`, because the same file
grants execute back to anon for the app telemetry path. As written, the correct outcome would have
looked like a finding. Corrected in place with the reasoning, rather than quietly reworded — a
verification step that cries wolf on a good result gets ignored on a bad one.

## Built and green this milestone

| | |
|---|---|
| **BUG-204** | Scrubs prove the rows are gone. Count before, delete with the count header, count after, retire only on zero. Storage gets the same three numbers plus the confirming list the old code never made |
| **BUG-203** | A failing scrub is visible. The card says "Still removing X from your account" in place of "Backed up just now", from the second failure |
| **BUG-207** | Deleting a Rise thread leaves a tombstone, so the restore stops resurrecting it |
| **BUG-205** | The Sales Brain upload follows the transcripts toggle, and switching transcripts off scrubs the brain already uploaded |
| **BUG-206** | Empty brains never upload. Forget everything removes every shadow copy beside the live file, and the import ledger so a rebuild works |
| **BUG-213** | FIXED ON PRODUCTION. A definer function the shipped anon key could call is now denied. Plus the guard that parses every definer function and fails when one relies on the default PUBLIC grant |
| **BUG-211** | The defaults-ON correction propagated to the six places it was load-bearing |
| **BUG-210** | The revokes for the eight alerts functions and five alerts tables are written, guarded, and will apply the moment that schema is deployed |

Three copy strings shipped in the branch, with the destination corrected to a page that exists.

---

## Waiting on you, in the order I would take them

**1. The copy, round three.** Now that the brain follows the transcripts toggle, the sentence the
app failed to say in seven places gets short. I have not drafted it because the behaviour changed
under it twice already, and a third round against a moving target wastes your reading. Say go and
you get five sentences.

**2. BUG-206's remaining half.** The erasure receipt itself is designed and not built. The shape is
approved, four panel corrections carried, and one open question: making zero-row brains unuploadable
reverses a recorded decision, which you approved, but the receipt work also needs the tombstone
ordering decision confirmed.

**3. BUG-212.** The scope question. "Tasks, Calendar events, Call titles, summaries & coaching
scores" carries full event notes, a free-text client name, and the AI summary of every conversation
with resolved buyer names. Three options in the entry, cheapest first.

**4. The shadow families.** 79 found, two fixed. The one that outranks the rest is that Sales Brain
memories survive the call they were mined from, which makes deleting a call's own stated promise
false. The cheapest large win is a retention cap on crash dumps, which hold live transcript text and
any AI key in use and which nothing has ever deleted.

**5. The release.** It waits behind all of the above, on your instruction.

---

## Still carried from before this milestone

- The paid Gemini key, for a real re-extraction rather than one on a copy
- VM login for the packaged-build walk
- BUG-199, `evidence_speaker`, which CRM first
- The HUD observation on a real call, which is yours

---

## One thing I would put in front of you unprompted

**Three of the last four findings came from checking a thing I had just written, not from checking
the product.** The species-number collision was found while citing a number. BUG-213 was found while
writing the fix for BUG-210, by asking whether the pattern I was comparing against was itself
correct. The abort in this SQL was found while preparing to run it.

That is a good ratio and it is also a warning: the things I produce are landing in the same tree as
everything else, and they have the same defect rate. The guards that caught them were all guards
that read the artifact rather than the intention.
