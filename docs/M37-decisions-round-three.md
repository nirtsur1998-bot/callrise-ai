# Copy round three, BUG-212's cost, the memory trade, and the CRM answer

**2026-09-08.** Gate green at 393 files, 3756 tests. Nothing merged, nothing released.

---

## 1. The copy: refuted again, and this time the refutations are product bugs

All five drafts came back FALSE or MISLEADING, and every one needed a second sentence to stand up,
which is the bar you set. **But the failures are no longer about wording.** Round one died on
Deepgram. Round two died on the Sales Brain's quotes. Round three died on six things the product
actually does, five of which nobody had written down.

**One of them was mine and is already fixed.** My transcripts gate left the Backup card showing
"Sales Brain memories" as ON and counted in "N of 7 synced", while the upload was blocked by the
toggle beside it. On a fresh profile that is the shipped state. The row now says "not syncing while
transcripts are off", the switch reads off, the count excludes it, and the stored preference is
untouched.

**The other five are open and each one falsifies a sentence:**

| Finding | Which draft it killed |
|---|---|
| Call summaries never use the Sales Brain at all. Only coaching, live cues, Rise and prep briefs do | "summaries stop starting from scratch", which the checklist has claimed for months |
| Not every Sales Brain fact carries a quote. Reflection facts cite other memories, and backfilled facts come from CRM form fields with no AI call and no call at all | "every fact carries a word-for-word quote" |
| Approving a mined objection copies the buyer's verbatim words into a Knowledge Base entry, which syncs on a **different** toggle | "with transcripts off, nothing verbatim leaves" |
| A signed-out user's queued scrub never drains. The push returns before the drain, so switching a category off and signing out leaves everything in the account indefinitely, silently | the erase promise generally |
| Google-sourced calendar events are never backed up. Only `source === 'local'` is pushed | "cloud backup includes your calendar events" |

**So I am not sending you five sentences to approve.** Three of the five sites cannot be made true
in one sentence until something changes, and you told me a draft that needs a second sentence is not
the draft. The honest position: fix the five above, then the sentences get short. Two of them are
copy-only and I can do them today if you want them separately.

Also a correction to my own briefing: I told the drafters that prep briefs and deal intelligence
receive raw transcripts. They do not. Deal risk is built on paraphrased summaries and says so; prep
briefs run before a transcript exists.

---

## 2. BUG-212: nothing reads them. What breaks is the removal itself

**Direct answer to your question.** Four of the six things you asked me to check came back clean.
No server-side trigger, function or view reads any of these fields. The alerts schema reads only
dates and ids. Search does not score on summaries.

**What breaks is not a consumer. It is the restore.** All three importers are full replaces, not
field-wise merges. Stop pushing a field and the next winning pull **deletes it from the machine
that has it.**

- `importCall` builds `summary` from the cloud payload alone, with no fall back to the local value,
  while doing exactly that for segments, bookmarks, coach chat and commitments right beside it. That
  is a latent bug today, before any change.
- `importEvent` rebuilds the record and keeps only the provider link fields. Notes come from the
  payload or nowhere.
- `importTask` never reads the local record at all.

**And for notes the loss escapes the app.** After a notes-less import the event is marked dirty, and
the push to Google or Outlook sends `description` unconditionally. **A user's real calendar entry is
emptied.**

### The three options, costed

| | Change | Cost |
|---|---|---|
| **1. Say it properly** | Rewrite the three labels to name what actually travels | Hours. Three strings plus three stale doc comments. No behaviour change, no migration, nothing to verify on a second device |
| **2. Toggle, defaulting ON** | One or two new scope keys gating the fields | Much more than it looks, and the premise is false |
| **3. Stop pushing them** | Two field deletions | Cheapest to write, most expensive to live with |

**Option 2's premise does not hold, and the codebase already says so.** A new key defaulting ON is
OFF for every existing install the moment they upgrade, because an absent key resolves to false.
That is BUG-211. Worse, the scrub is queued only by the diff inside a settings save, and an
upgrade-time resolution is not a save, so nothing is queued and nothing is removed. Every existing
user would see the toggle off, their summaries would stop syncing, and the copies already uploaded
would stay forever.

**And there is no delete path for them.** `backup_calls` and `backup_events` deliberately have no
delete policy: deletions travel as a flag. So "turn summaries off" cannot remove the summaries
already there without new SQL.

**Turning it off would also wipe the summary on the user's own machine**, single device, no edge
case: the pull rewrites the payload timestamp to server receipt time, which is always later than the
local edit, so the summary-less payload wins on the very next pull.

**My recommendation: option 1 now, option 2 only after the importers learn that absent means
preserve.** That importer work is worth doing on its own merits, because the `importCall` summary
gap is a live bug independent of any of this.

---

## 3. The memory trade, measured on your actual store

Not estimated. Read from `memory.db` read-only.

| | |
|---|---|
| Live memories | 73 |
| Distinct sources | 46 (43 calls, 3 Rise chats) |
| Memories with evidence from exactly one source | 68 of 69 |
| Verbatim transcript held | 5,532 characters across 81 entries |
| Mean quote | 68 characters. Longest 269. The 400 cap is never reached |
| **Cited calls that are already deleted** | **25 of 43** |

**That last row is the finding.** You have already deleted 25 of the 43 calls your Sales Brain
quotes, and their verbatim buyer speech is in the Brain right now.

### The three options

**A. Delete the memories the call taught.** Makes the promise literally true. Costs a median of one
fact per deleted call and up to five for the heaviest. The argument against it is strong: the user
deleted a recording and gets charged learning. "Don't learn from this call" is a statement about
learning and says what it costs; "delete" is a statement about the recording.

**B. Strip the quote, keep the memory.** Satisfies the promise on 68 of 69 rows without destroying a
fact. But as scoped it ships a broken screen: the evidence modal renders curly quotes around nothing
and an "Open the call" button pointing at a deleted call. That is the hollow-green shape rendered in
the one widget built to prove evidence.

**C. Redact at delete time, keep the memory, fix the copy, sweep the backlog.** Destroys the
verbatim span, keeps the fact and the citation stub with honest wording, and sweeps the 25 calls
already deleted.

**My recommendation is C**, and the reason is the 25. Whatever you choose for the future, there is a
backlog on your own machine today, and only C addresses it. B's broken modal is fixable in the same
commit; A is the only one that destroys knowledge the user never asked to lose.

---

## 4. The other two shadow families

**Prep briefs and job results.** No delete function for a prep brief exists anywhere in the repo,
and the filename is a truncated hash so you cannot find the one belonging to a record you deleted.
**Decision needed:** either a retention policy, or they join the companion registry that deletion
already walks. I would take the registry, because it is the thing that stops the list growing.

**Conflict copies.** Deliberate, surfaced in the card, and never removed after the user resolves the
conflict. The objection-queue ones hold verbatim buyer quotes. **Decision needed:** surfaced-and-kept
is a reasonable design; surfaced-and-kept-forever probably is not. I would add a "clear resolved
conflicts" action rather than a timer, so it stays the user's call.

---

## 5. The CRM: Attio first

**Because the read-only guarantee can be a property of the token rather than a property of my code.**

Attio issues credentials with the scope chosen at creation time, with separate read and read-write
variants. You said a sync that corrupts someone's CRM is the failure that would end the product.
With Attio you can verify in their UI, in ten seconds, that the key I hold cannot write. With every
other option in the set, "we do not write" is a promise about my code, and you would be right to
want a scope-verification test instead of my word.

The free plan is $0 for three seats and 50,000 records with API and webhook access, and the
credential is a pasteable bearer token, so there is no OAuth secret a desktop app cannot hold.

**HubSpot second, for reach.** Its free tier is defensible but three assumptions under it are wrong:
no PKCE so a client secret is mandatory, a 25-install cap until marketplace review, and a custom
property cap that means sync bookkeeping cannot live in HubSpot.

**Salesforce is not second and not third.** Its SMB editions have no API at all. The edition that
does is $195 per user per month, so the small-team rep on Salesforce is unreachable at our price
point regardless of what we build.

**Not a unified-API vendor.** Merge, Nango and Paragon each need a server-side secret. A desktop app
with no backend fails architecturally before it fails on price.
