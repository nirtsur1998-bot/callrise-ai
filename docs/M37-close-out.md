# M37 — Close, Prepare, Wedge, Imagine: the close-out

**2026-09-08. Branch `claude/m37-close-prepare-wedge-imagine`, 48 commits, not merged, not
released.** Gate GREEN at HEAD: 400 test files, 3802 tests, typecheck exit 0.

The milestone opened as "close the loop, prepare the release". None of what follows was in scope
when it started.

---

## THE FOUR THINGS THIS MILESTONE ACTUALLY FOUND

**1. A false privacy claim on ten surfaces.** "Your data lives only on this device", in ten places,
while seven categories of user data upload to Supabase and the transcript reaches the AI provider on
every feature that reads a call. Found by sweeping the container for the VOCABULARY of the claim
rather than for the sentences anyone knew about — two of the first five sites were in files nobody
had thought to look at.

**2. An erase path that could not erase.** A `DELETE` that row-level security filters to zero rows
returns byte-identical success to one that removed everything, so "Forget everything" reported an
erase it had never performed. Fixed by counting before and after and refusing to claim success on an
unmoved count.

**3. A third data destination nobody had in their model.** The raw microphone audio of every call
streams live to Deepgram, always, with no control of any kind — and the product had never said so.
Four rounds of privacy copy failed partly because everyone involved, me included, was sorting data
into two boxes when there are three.

**4. A month-long silent feature failure caused by two origins sharing a database but not a
preference.** 137 of 191 calls untitled, on a feature the founder believed was on.

Each of the four is a different failure of the same kind: **something was true of the container
people were looking at, and the container was the wrong one.**

---

## WHAT SHIPPED, AND HOW EACH THING IS KNOWN TO WORK

The distinction the founder asked for, kept strictly. **Observed** means driven in the running app
or read off the server, with the state read back afterwards from an instrument that shares no code
with the thing under test. **Tested** means a check in the suite that has been red-checked. Most of
the important items are both; where something is only one, it says so.

### Privacy and erase

| What | Observed | Tested |
|---|---|---|
| Erase actually erases | **Yes** — driven on production: `attachments` bucket 1 object → 0 → 1, Rise rows 0 → 14 → 0, read back by an instrument sharing no code with `backup.ts` | Yes — count-before/count-after, red-checked |
| BUG-213, an anon-callable `SECURITY DEFINER` delete | **Yes** — live on production: `405 25006` → `401 42501`, and the SQL was hashed against the committed file before Run | Existence-guarded SQL with its own verification SELECT |
| The Sales Brain upload gated on the transcripts toggle | No | Yes — the row logic is anchored on its declaration, after a hollow version stayed green with the logic deleted |
| Quote redaction at delete, facts kept | **Yes** — 43 quotes, 2,537 characters, 36 memories touched, 73 kept, 0 facts lost, verified by comparing before/after snapshots rather than the log line | Yes |
| The pre-migration Sales Brain backup deleted by "Forget everything" | No | Yes — the directory is enumerated, and the guard excludes `-wal`/`-shm`, which is load-bearing because the wipe lives in the WAL |
| Crash-dump retention capped at 14 days | No | Yes |

### The copy

| What | Observed | Tested |
|---|---|---|
| The three approved Sales Brain strings | **Yes** — read on screen | Yes, pinned |
| The nightly reflection disclosure | No | Yes — **code half asserted first**, so if reflection stops calling the provider the test asks for the sentence to come out |
| The Deepgram sentence, all three placements | **Yes** — rendered under the key input | Yes — the code half (`wss://api.deepgram.com`, `ws.send(frame.bytes)`) is asserted before the copy |
| "Call recordings" → "Call transcripts", five sites | **Yes** | Yes, pinned by name — a label is a noun, not a claim, so the locality sweep can never catch it |
| The three-destination opening card | **Yes** | Yes — asserts all three destinations appear, in order |
| The scope line above the toggles | **Yes** | Yes |

### The titles

| What | Observed | Tested |
|---|---|---|
| The preference survives | **Yes** — one real click moved the settings FILE false → true, and it survived a full restart | Yes |
| The save handler calls the sequence when a call ends | No — a driver would have to speak into a microphone | **Yes** — the real hook, a real call driven to its end, red-checked in BOTH directions (link removed: 2 fail; gate ignored: 3 fail) |
| The title survives a model that will not call a tool | **Yes** — 3 of 8 → 6 of 8 on real calls | Yes, red-checked |
| A failure says why | **Yes** — the two remaining failures were diagnosed in seconds from their own log line | Yes |
| The manual "Generate title" | **Yes** — an untitled call became "Audio and Microphone Setup Test" in ~1s, verified on disk | No — UI-only, covered by the driven run |
| The backfill: count, one action, stop partway, per-call failures | **Yes** — offered 125 = 125 on disk; Stop honoured mid-run ("Named 3 of 4 before you stopped it"); disk 125 → 122; failures named each provider in its own words | Yes — the loop is extracted as pure logic and covered directly |

### Other behaviour

BUG-221 (a meeting cancelled in Google/Outlook no longer re-created), BUG-207 (deleting a Rise
conversation sticks), BUG-216 (a signed-out erase is no longer silent), BUG-215 (deleting a call
takes its words out of the Sales Brain and leaves the fact) — all tested; 221 and 215 also driven.

---

## WHAT IS STILL OPEN

**34 open entries** in the tracker overall. The ones that matter for this milestone:

- **BUG-234 (new, HIGH)** — every structured feature in the app asks for a TOOL CALL, and no
  provider adapter can request structured output at all. Twelve-plus features. Verified in the code,
  not taken from research. This is the general form of the title bug and the single change most
  likely to raise reliability across the whole app. See the provider note below.
- **BUG-205** — three false locality sites remain pinned and awaiting word-by-word approval.
- **BUG-200, 202, 208, 209, 212, 217, 218** — the copy and disclosure family; each needs a decision
  rather than code.
- **BUG-230** — a recovered call still gets no title, no summary and no brief. Logged, not built.
- **BUG-199** — contacts and deals leave the device unclassified by the compile-time egress guard.
- **BUG-233 (new, LOW)** — a job that stopped early reports `125 of 125` in the Activity Center.
  Deliberately not fixed: it is shared job machinery with a correct reason for its current
  behaviour, and the fix needs a distinction the manager cannot currently make.

## WHAT WAS DEFERRED BY DECISION, NOT FORGOTTEN

- **BUG-222** — client facts in live cues. Deferred by the founder after the costing, with
  **BUG-225** (the cue latency instrument records every cue and nothing reads it) and **BUG-226**
  (the live meeting match has no tie-break, and client data already rides on it) logged as
  prerequisites. Both worth doing regardless.
- **BUG-223** — disclose rather than gate. Decided, and the scope line shipped.
- **BUG-219** — fix the sentence, not the behaviour. Decided.
- **BUG-212** — option one, say it properly; the importers learning absent-means-preserve is logged
  as the prerequisite for option two.
- **BUG-220** — **withdrawn by me** after the founder made me check it. The filter I reported was a
  tautology. Recorded in the entry, because a withdrawal that leaves no trace teaches nothing.
- **The paid key and the VM login** — the founder's.
- **The release** — behind everything, on the founder's word.

---

## THE PAID KEY

**Recommendation: Claude Haiku 4.5.** ~$17.60/month list for this workload, ~$12.60 with prompt
caching on the live-cue leg, which is 78% of all input tokens. It is the only option surveyed
pairing a documented constrained-decoding guarantee on **both** JSON output and tool arguments with
an entry paid tier this workload cannot come close to saturating (1,000 RPM / 2M input TPM), and if
the coaching report alone needs more model, Sonnet 5 is the same key, same SDK, same schemas — no
second provider.

**Runner-up: OpenAI's cheapest current-gen strict-schema model,** roughly a fifth of the price. The
reasons it is not first are a tighter entry tier and that its coaching quality on ~2,700-token
transcripts is unmeasured at that price point.

**Two honesty notes on this recommendation, because it is the one part of this document I did not
verify myself:**

1. **The prices and rate limits came from web research, not from me reading a bill.** They are
   sourced with URLs in `docs/` but they were not independently re-checked, and pricing pages move.
   Treat them as a starting point for a decision, not as measured figures — everything else in this
   close-out is measured.
2. **The provider may not be the binding constraint.** BUG-234 is: the app asks for tool calls where
   structured output is the guaranteed path, and on at least one provider those two features are
   mutually exclusive by documentation — meaning a tool call there is best-effort **by
   construction**, which matches the measured ~40% failure rate exactly and would **not** be fixed by
   paying that provider. Fixing BUG-234 costs nothing and helps whichever key you buy.

**What I would actually do:** buy the Haiku key, and before wiring anything else, run a bake-off on
20 real transcripts across both candidates using structured output rather than tool calls. Count
schema failures (expect zero on both) and *semantic* failures, where the JSON is valid and the
content is wrong. The second number is the one no pricing page can tell you, and at a ~$14/month
spread it is the only number that should decide it.

---

## THE THING WORTH CARRYING OUT OF THIS MILESTONE

Five species were added to the taxonomy (88–92). Two of them are the milestone's real product:

**Species 91, the incomplete category set.** Nothing was ever mis-sorted. Every individual judgement
was correct against the categories in hand, the categories were missing one, and that produces
confident wrong answers indefinitely because the error is not in any of the answers. It survived a
founder, an assistant, several drafters and several adversarial verifiers — because none of them was
ever asked *what are the categories*, and every question they were asked presumed the answer. **When
a whole class of answer keeps needing correction, stop checking the answers and enumerate the
categories.**

**Species 92, the free pass by proximity.** A sweep finds what it has a pattern for; the clause
beside the match inherits its verdict unearned, in both directions. Two sites sat pinned as lies for
a week and were true. The correction was structural: the pending list now requires a written
argument, exactly as the allowlist always has. *A list of things you call false with no argument
attached rots exactly like a list of things you call fine with no argument attached.*

And the practice that paid most, at the top of the trigger index: **verify the claim first, and say
plainly when it does not hold.** It caught a bug I had logged from an unverified adversary claim
(BUG-220, withdrawn), a wrong fix shape, a wrong premise about defaults, and — twice today — an
instrument of mine that disagreed with the app when the app was right.
