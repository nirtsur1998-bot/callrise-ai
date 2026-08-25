# Fix shapes for sweep items 1, 2 and 4 — for approval before building

**Date:** 2026-08-24. Nothing in here is built yet. Items 3, 5, 6, 7 and 8 are
being built directly with red-then-green, per the founder's instruction.

Note on grouping: sweep item **1** (`syncScope.salesBrain` has no UI) and sweep
item **4** (an empty `memory.db` defeats the restore guard, then `upsert: true`
overwrites the cloud brain) are **one commit**, because shipping the toggle
without the guards converts "backup does nothing" into "backup destroys the
backup." They are written together below as FIX A.

---

# FIX A — the Sales Brain backup path: make it reachable *and* make it safe

## A1. Kill the type drift structurally

**The defect.** `BackupSyncScope` in the main process has six keys. The
renderer hand-writes its own five-key copy:

```ts
type SyncScopeKey =
  'transcripts' | 'attachments' | 'knowledgeBase' | 'settingsPersonalization' | 'contacts'
```

Because it is an independent literal union rather than a derivation, TypeScript
cannot see that it disagrees with main. This is the same species as the dual
`DealIntelligenceStatus` declarations.

**The fix, in two layers — the second is the one that actually bites.**

*Layer 1, compile time.* Derive rather than copy:

```ts
type SyncScopeKey = keyof BackupSyncScope
```

Caveat I want to be honest about: the renderer consumes settings types through
`preload/index.d.ts`, which may itself carry a hand-written copy. If it does,
deriving from it only moves the problem one file. So layer 1 alone is **not**
sufficient, and I will follow the chain to whatever the renderer actually
imports and derive from the single real source, adding a `satisfies` check if the
preload copy has to stay.

*Layer 2, runtime — the real guard.* A test that compares the UI's list against
the **actual main-process object**, not a type:

```ts
expect(OPTIONAL_ITEMS.map((i) => i.key).sort())
  .toEqual(Object.keys(EMPTY_SYNC_SCOPE).sort())
```

This cannot drift no matter how many type copies exist: add a scope key without
a UI row (or vice versa) and the suite goes red. **Red-check:** delete the
`salesBrain` row from `OPTIONAL_ITEMS` and watch this specific assertion fail
before restoring.

## A2. Add the missing UI writer

One row in `OPTIONAL_ITEMS` for `salesBrain`, using the existing toggle
machinery (`setScope` already writes any key generically, so no new plumbing).

Label and description matter here, because this toggle is disaster recovery for
the user's most irreplaceable data. Proposed copy:

> **Sales Brain memories** — A copy of everything CallRise has learned about
> your deals and your style. Off by default; turning it on stores one encrypted
> copy in your account so a lost or replaced computer doesn't lose it.

## A3. The restore guard must stop trusting "a file exists"

**The defect.** `downloadSalesBrainDb` refuses to restore if `memory.db` exists
at all:

```ts
await fs.access(dbPath)
return // already have a local copy — never overwrite it from the cloud
```

But `openMemoryDb` **creates** that file before anything can fail — the WAL
pragma and `loadExtension` both throw *after* `new DatabaseCtor(dbPath)`. So a
failed init, or a brand-new enable, leaves an empty husk the guard reads as
"local truth worth protecting."

**The fix.** Replace the existence test with a *content* test, and never destroy
either copy when the answer is uncertain:

| local state | decision |
|---|---|
| no file | restore from cloud (unchanged) |
| file with **≥1** row in `memories` | do **not** restore — local wins (the M25 invariant, preserved) |
| file with **0** rows | restore from cloud — an empty brain is not "local truth" |
| file **unopenable / corrupt** | rename it aside to `memory.db.local-unreadable-<ts>`, then restore |

That last row matters: treating a corrupt file as restorable would silently
destroy a possibly-recoverable database. Renaming aside preserves both copies and
costs one file.

New helper (small, its own function so both callers share it):

```ts
/** Rows in `memories`, or null if the DB is absent/unopenable. Never throws. */
function localMemoryCount(dbPath: string): number | null
```

Opened readonly, **without** the sqlite-vec extension — same reasoning as
`snapshotMemoryDb`: a counting read must keep working on a machine where the
vector extension is broken.

## A4. The upload must refuse to overwrite a real backup with an empty one

This is the irreversible half — Supabase Storage `upsert: true` has no version
history — so it gets its own independent gate rather than relying on A3 being
correct.

**Rule:** if the local snapshot has **0** memories **and** a cloud object already
exists, do not upload. Report it as a real, counted step failure
(`reportBackupStep('salesBrainUploadRefusedEmpty')`) so it shows up as a
dashboard row rather than archaeology, and surface it on the backup card rather
than reporting "Backed up just now."

Fail closed toward preserving the cloud copy. An upload we skip is recoverable;
an overwrite is not.

## A5. Reopen BUG-087 / BUG-088 / BUG-089 as **unverified, not fixed**

Agreed, and the founder's framing is the right one — "fixed in code" is species
23 wearing a different hat. All three live behind a gate nothing could turn on,
so none has ever executed in production.

Their status becomes: *fix present in code; **never executed**; verification owed
against the real trigger on the cutover VM.* The claim-audit rows in
`docs/M29-A1-plan.md` get the same correction — they currently say "verified by
a test," which was true and irrelevant, because the test called the function
directly and the product never does.

## Verification plan for FIX A

- Drift pin red-checked by removing the new UI row (A1).
- Restore guard: a test per row of the table above. The **0-rows** and
  **corrupt** cases are the new behaviour; the **≥1 row** case re-asserts the
  M25 invariant so the fix cannot quietly weaken it.
- Upload refusal: fixture with an empty local DB and a non-empty cloud object;
  assert **no** upload call happened and a step failure was counted. Red-check by
  removing the guard and watching the cloud object get clobbered in the test.
- The existing BUG-088 WAL test and BUG-089 sidecar test must both stay green —
  they are the regression floor.
- Full suite + both typechecks, exit codes read directly.

**What this still does not prove:** that any of it works against a real bucket.
That is the cutover VM's job, and it stays owed.

---

# FIX B — the scrubber's spaced-username leak (sweep item 2)

## The defect

Three rules are meant to cover the username; on `C:\Users\Nir Tsur` all three
fail together for any spelling not immediately followed by a slash:

1. `homedirPattern` ends with `(?=[\\/]|$)` — a quote or space after the path defeats it.
2. `WIN_PROFILE`'s capture class is `[^\\/\s"'<>|:*?]+` — `\s` is negated, so the capture **stops at the space** and only `Nir` is replaced.
3. `userPathRe` carries the same lookahead **and runs last**, after `WIN_PROFILE` has already rewritten `\Nir` → `\<user>`, so the literal it searches for no longer exists.

The "two independent mechanisms" the A1 red-check credits are not independent:
the generic rule destroys the exact rule's input.

## The fix

**B1 — reorder: exact before generic.** `userPathRe` knows the real account name
from `os.userInfo()`. That is the *most* precise rule we have and it currently
runs last. Move it **before** `WIN_PROFILE`/`MAC_PROFILE`/`LINUX_PROFILE` so it
gets first claim on the text it can match exactly.

**B2 — fix the boundary, don't widen the capture.** The tempting fix — dropping
`\s` from `WIN_PROFILE`'s class so it spans spaces — is wrong: it would swallow
prose (`C:\Users\Nir Tsur and it is fine` → the capture eats the whole sentence).
Over-redaction is a real cost; it destroys the diagnostic value of the log.

Instead, for the *exact-literal* rules (`userPathRe`, `homedirPattern`) replace
the slash-only lookahead with a **word-boundary-style** one:

```
(?![A-Za-z0-9])
```

The next character after the known username must not be alphanumeric. That
allows a quote, a space, a comma, or end-of-string to terminate the match, while
still refusing to match `Nir Tsur` inside `Nir Tsurson` or `Nir Tsur2`.

`WIN_PROFILE` keeps its current conservative class — it remains the generic
fallback for *other* people's names in paths, where we have no literal to anchor
on and over-redaction is the greater risk.

**B3 — a defensive rule for the shapes we know we cannot anchor.** The sweep also
found (and correctly dropped as "no concrete egress path *today*") that UNC
paths `\\SERVER\Share\…` survive intact and that Mistral's key shape matches no
`SECRET_PATTERN`. Both are cheap to close and belong here rather than waiting for
a path to open.

## B4 — the hostile fixture set (the founder's standing instruction)

> *"Every privacy test from now on runs against a hostile fixture set, not this
> machine's happy accident."*

New shared module — `src/main/telemetry/__tests__/fixtures/hostile-identities.ts`
— exporting a list every privacy suite iterates. Proposed contents, each with a
one-line note on what it is designed to break:

| fixture | breaks |
|---|---|
| `Nir Tsur` | space in the account name (this bug) |
| `O'Brien` | apostrophe — also a regex-escaping hazard |
| `José García` | non-ASCII **and** a space |
| `李明` | non-ASCII, no Latin characters at all |
| `User` | a name that is also a common English word (this machine's happy accident, kept deliberately) |
| `Nir` / `Nir Tsur` pair | prefix collision — the short name must not half-match the long one |
| `a` | single character, maximal false-positive pressure |
| `Administrator.DOMAIN` | dot in the name |
| `\\ACME-FS01\Deals` | UNC path, no drive letter |
| a 200-char name | length, and interaction with the 4096 cap |

Consumers: the scrubber suite, the telemetry privacy-invariants suite, and the
support-bundle privacy pin. Each asserts, for **every** fixture, that the raw
identity string does not appear in the output — with a control proving it was in
the input.

This is the part with the longest half-life. The specific regex fix closes one
hole; the fixture set is what stops the next one being invisible for the same
environmental reason.

## B5 — BUG-094: the diagnostics zip scrubs nothing (added to FIX B by the founder, 2026-08-24)

**Why it belongs here rather than in its own batch:** it is the same defect
class as BUG-093 — a username reaching an egress path — and the founder's call
was that **one hostile-fixture set should cover both egress paths at once**.
Fixing the scrubber (B1–B3) without fixing this leaves a path the scrubber is
never called on, so B4's fixtures would prove less than they appear to.

**The defect.** `exportTier1Diagnostics` (`src/main/tier1-diagnostics.ts`) has
no scrubber at all — `grep scrub src/main/tier1-diagnostics.ts` returns
nothing. Two unscrubbed writes:

- `:129` — `copyFileSync(src, join(staging, …))` copies each engine log
  **byte-for-byte**. M29's own Phase 0 audit §1.4 records those logs carrying
  `C:\Users\<name>\…`.
- `:136` — `buildAppDiagnostics(renderer)` is a plain `JSON.stringify` of
  `tier1Status` (which includes `enginePath`, an absolute path) and the
  renderer-supplied `deviceLabels` (microphone names, which routinely contain a
  person's name — "Nir's AirPods").

It was concealed by a phantom citation: `M29-A1-plan.md` claimed all three
egress paths shared one `buildOutbound()`. That function never existed.

**The fix.**

1. **Route the engine-log copy through the same per-line scrub the support
   bundle uses.** `support-bundle.ts`'s `scrubbedCopy` already does exactly
   this; extract it to a shared helper rather than writing a second copy — the
   one-mechanism rule from A5.2, applied again. Note `copyFileSync` must become
   read → scrub → write, so the "unreadable/locked log is skipped, never fatal"
   behaviour at `:131` must be preserved.
2. **Scrub `buildAppDiagnostics`'s output** with `scrubDocument` (the uncapped
   whole-document scrubber added in sweep item 7) — a `JSON.stringify` of a
   status object is a document, not a field, so the 4096 cap would truncate it.
3. **Consider consolidating the two exports.** The support bundle now collects
   the same engine logs, scrubbed, so the app currently has two support exports
   with *different privacy postures* — which is also the Phase 0 audit's §1.3
   complaint about three support paths. Consolidating closes this permanently
   instead of keeping two paths in sync. **Flagged, not assumed:** removing a
   shipped button is a product decision, so I will not do it without a word.

**Verification.** The B4 hostile-fixture set runs against **both** egress paths
in the same test: for every fixture identity, assert it appears in the planted
source (the control) and is absent from the support bundle *and* from the
diagnostics staging directory. Red-check by removing the new scrub call and
watching the diagnostics half go red while the bundle half stays green — that
asymmetry is the proof the two paths are independently covered.

## Verification plan for FIX B

- Red-check the ordering fix by restoring the original order and watching the
  spaced-username cases fail.
- Red-check the boundary fix by restoring `(?=[\\/]|$)` — the quoted and prose
  cases go red while the plain-path case stays green, proving the two are
  independent failures.
- Assert **no over-redaction**: a control asserting `…\Nir Tsur and it is fine`
  keeps ` and it is fine` intact after the username is replaced.
- Every existing scrubber test must stay green — 24 of them, including the
  prefix-collision and bare-word cases that exist precisely to stop
  over-redaction.

---

## What I need from you

Approve, adjust, or reject:

1. ~~**FIX A's restore-decision table** — particularly the *corrupt → rename
   aside and restore* row.~~ **APPROVED (founder, 2026-08-24):** *"Your
   reasoning is right — treating a corrupt file as restorable destroys
   something possibly recoverable, and a stray file on disk costs nothing.
   When the choice is 'might lose data' vs 'might leave clutter,' clutter
   wins."* That last sentence is the general rule, not just this row: it now
   governs every ambiguous case in this fix. Build the table as written.
2. **FIX A's upload refusal being a hard block** rather than a warning. I think a
   silent skip that reports honestly is right, because the alternative is an
   irreversible overwrite — but it means a user with a genuinely empty brain and
   an old cloud copy can never push the empty state until they delete the cloud
   object.
3. **FIX B's boundary choice** — `(?![A-Za-z0-9])` on exact-literal rules only,
   leaving `WIN_PROFILE` conservative. The trade is that another user's spaced
   name in a path we have no literal for still half-redacts. Closing that would
   cost real over-redaction of prose.
4. **The hostile fixture list** — additions welcome, especially any account-name
   shape you have actually seen on a customer machine.

---

# Prep findings, folded in 2026-08-24 (all three confirmed before building)

**1. The layer-1 caveat is resolved — and better than feared.** There are THREE
declarations, not two: `app-settings.ts:583` (main, 6 keys), `preload/index.d.ts:1708`
(hand-copy, **also 6 — complete**), and `BackupCard.tsx:85` (hand-written, 5).
So the drift was only at the third hop. `keyof BackupSyncScope` off the preload
type fixes it and makes future UI drift a compile error; a runtime pin
(`sync-scope-no-drift.test.ts`) covers the main↔preload hop that types cannot.

**2. The empty-husk premise verified empirically — there are TWO husk shapes.**
Measured: `new Database(path)` creates the file at **0 bytes** before the WAL
pragma or loadExtension can throw; a successful schema-only init is **8192
bytes with zero rows**. Both defeat an existence check, and the approved
decision table covers both — the 0-byte one is unopenable (rename aside), the
8192-byte one opens with 0 rows (restore). A 0-byte husk also cannot be
uploaded (snapshot fails), so it is specifically the 8192-byte one that A4's
zero-memory refusal catches.

**3. B5's "one helper, both callers" is clean.** `support-bundle.ts` imports
`tier1-diagnostics.ts` one-way and nothing imports back, so a shared
`scrubbedCopy` has no cycle risk; it already returns `false` rather than
throwing, preserving tier1's "a locked log is skipped, never fatal".

**All four open questions answered by the founder 2026-08-24:** corrupt → rename
aside and restore; upload refusal is a HARD BLOCK; `(?![A-Za-z0-9])` boundary on
exact-literal rules only; hostile fixture list as proposed.
