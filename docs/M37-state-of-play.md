# M37: what is done, what is blocked, and what is left

**2026-09-08.** Branch `claude/m37-close-prepare-wedge-imagine`, pushed. Gate green at 391 files
and 3744 tests. **Nothing merged, nothing released.**

---

## Blocked right now: the SQL

**I cannot run it.** The Claude extension in Chrome is not answering, on three attempts across two
turns, so I have no way to reach your logged-in Supabase session. Neither browser window is on
Supabase either — Chrome is on an OpenRouter key page and Firefox on a Groq key page, and I did not
read or capture those.

**To unblock me:** open the Claude side panel in Chrome and sign in with the same account as this
app. Then say go and I will drive it under the same two conditions as last time — read the editor's
model text and compare it byte for byte against the committed file before pressing Run, and stop
rather than retry if it does not match.

**Or run it yourself.** It is now self-verifying, which it was not when you approved it.

### What changed in the file since you approved it, and why it had to

As written it would have **aborted**. The alerts functions and tables do not exist on this project,
so the first alerts statement raises "does not exist", the editor stops the script there, and every
statement after it silently does not run.

The dangerous part was the ordering. The live telemetry fix is section 1, so it would have applied
while the run reported an error. A half-applied migration that looks like a failed one is the
version nobody goes back and re-reads.

Now every object is applied only if it exists, the script says which parts it skipped, and it
**ends in its own verification**: a select listing every security-definer function with whether
`anon` can execute it. That grid is what the editor shows when the run finishes. **Every row must
read false.** One `true` is the finding.

---

## Built and green this milestone

| | |
|---|---|
| **BUG-204** | Scrubs prove the rows are gone. Count before, delete with the count header, count after, retire only on zero. Storage gets the same three numbers plus the confirming list the old code never made |
| **BUG-203** | A failing scrub is visible. The card says "Still removing X from your account" in place of "Backed up just now", from the second failure |
| **BUG-207** | Deleting a Rise thread leaves a tombstone, so the restore stops resurrecting it |
| **BUG-205** | The Sales Brain upload follows the transcripts toggle, and switching transcripts off scrubs the brain already uploaded |
| **BUG-206** | Empty brains never upload. Forget everything removes every shadow copy beside the live file, and the import ledger so a rebuild works |
| **BUG-213** | The guard that finds definer functions relying on the default PUBLIC grant. The SQL that fixes them is written and not run |
| **BUG-211** | The defaults-ON correction propagated to the six places it was load-bearing |

Three copy strings shipped in the branch, with the destination corrected to a page that exists.

---

## Waiting on you, in the order I would take them

**1. The SQL.** One live issue: anyone holding the key from the shipped app can delete this
project's telemetry today.

**2. The copy, round three.** Now that the brain follows the transcripts toggle, the sentence the
app failed to say in seven places gets short. I have not drafted it because the behaviour changed
under it twice already, and a third round against a moving target wastes your reading. Say go and
you get five sentences.

**3. BUG-206's remaining half.** The erasure receipt itself is designed and not built. The shape is
approved, four panel corrections carried, and one open question: making zero-row brains unuploadable
reverses a recorded decision, which you approved, but the receipt work also needs the tombstone
ordering decision confirmed.

**4. BUG-212.** The scope question. "Tasks, Calendar events, Call titles, summaries & coaching
scores" carries full event notes, a free-text client name, and the AI summary of every conversation
with resolved buyer names. Three options in the entry, cheapest first.

**5. The shadow families.** 79 found, two fixed. The one that outranks the rest is that Sales Brain
memories survive the call they were mined from, which makes deleting a call's own stated promise
false. The cheapest large win is a retention cap on crash dumps, which hold live transcript text and
any AI key in use and which nothing has ever deleted.

**6. The release.** It waits behind all of the above, on your instruction.

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
