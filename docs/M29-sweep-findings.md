# M29 adversarial sweep — findings

**Date:** 2026-08-24. **Method:** 12 parallel read-only reviewers across the M29
surface (80 files, ~9.2k lines on `claude/m29-eyes-and-engine`), each required to
cite file:line and check prior art before reporting. **Every finding below was
then re-verified by me directly against the source** — the ones that did not
survive that check are listed at the end.

**Status: all 12 dimensions reported and verified.**

**Ordering hazards, explicitly (these interact):**
1. **C-1 must be fixed before the cutover** or the RAMP gate cannot pass — and
   **C1 must ship in the same commit**, or enabling the toggle turns "backup does
   nothing" into "backup destroys the backup."
2. **C2 must not reach the cutover in its current form.** It was sequenced
   *before* cutover so telemetry works during the ramp; as written it does the
   opposite exactly when the new project is most likely misconfigured.
3. **C-2 breaks the cutover's own detection path.** The runbook says activation
   bugs are noticed "via telemetry from cutover installs" — which relies on
   `job.finished`, the signal that drops precisely the `backup:sync` failures.
4. Cutover fixes BUG-084, so `skewMs` becomes non-zero for the first time,
   activating a normalisation branch in `upsertRows` never previously executed.
   No defect found by inspection; noted as newly-live.

**Nothing here is fixed.** Per the standing rule for real defects, fix shapes are
proposed for confirmation before any code changes.

---

## CRITICAL — three "fixed" bugs live in code the product cannot reach

### C-1. `syncScope.salesBrain` has no UI, so the entire Sales Brain cloud backup **and** restore path is unreachable

Main declares six sync scopes including `salesBrain: boolean`
(`app-settings.ts:602`). The renderer declares its **own hand-written union with
five** (`BackupCard.tsx:85`):

```ts
type SyncScopeKey =
  'transcripts' | 'attachments' | 'knowledgeBase' | 'settingsPersonalization' | 'contacts'
```

Because it is an independent copy rather than `keyof BackupSyncScope`,
TypeScript cannot see the drift. Verified: **no writer of `syncScope.salesBrain`
exists anywhere in the renderer.** It defaults to `false`, and
`applyPulledSettings` preserves local `syncScope`, so it cannot arrive from the
cloud either.

Both cloud paths are gated on it — `backup.ts:681` (upload) and `:962`
(download).

**Confirmed on the founder's live install:**

```json
"syncScope": { ..., "salesBrain": false },
"salesBrain": { "enabled": true }
```

Sales Brain is on; its backup has been off and unreachable the entire time.

**What this means for the three bugs we just closed:**
- **BUG-087** ("the bucket was never created, so upload fails into a swallowed
  console.error") — the upload never even **ran**; the gate was off.
- **BUG-088** (WAL-blind upload) and **BUG-089** (restore sidecars) — both fixed
  inside functions the product cannot call.

**And the cutover RAMP gate cannot pass.** It requires seeing
`sales-brain/<uid>/memory.db` appear with a fresh timestamp, and the restore test
on the clean VM sits behind the same dead gate. Neither can be satisfied from the
product UI; it needs hand-editing `app-settings.json`.

This is species 16+24 compounded one level further than we caught it: my own
activation audit inspected these function *bodies* without checking whether
anything **reaches** them.

**Fix shape:** derive the renderer union from the main type
(`type SyncScopeKey = keyof BackupSyncScope`) so drift is a compile error, add the
sixth row, and pin it with
`expect(OPTIONAL_ITEMS.length).toBe(Object.keys(EMPTY_SYNC_SCOPE).length)`.

**Ordering hazard — this must ship in the same commit as C1.** Turning the
toggle on without fixing the empty-husk guard converts "backup does nothing" into
"backup destroys the backup."

### C-2. `backup:sync` failures never reach telemetry — the dashboard would show 100% success while nothing syncs

The sync job attaches the error *message* as the error *code*
(`backup.ts:1153`), so `code` becomes e.g.
`backup_tasks: Could not find the table 'public.backup_tasks' in the schema cache`.
`JobManager.errorCode()` passes any string through unfiltered, and `buildEvent`
then rejects **the entire event**:

```
prose code passes TOKEN?  false   ->  whole event REJECTED
```

Successful syncs carry no `code`, so they record normally. **Failures are dropped
locally before they reach the queue; successes are not.**

On cutover day, if anything is wrong with the new project, every user's sync
fails and the dashboard reports `backup:sync` at a 100% success rate.

`backup.ts` gets this right for its *own* signal — `reportBackupStep` validates
the code against a short-identifier regex and drops just the field. The
JobManager funnel, added later, has no such guard, so two signals from the same
subsystem behave oppositely.

**Fix shape:** sanitise `code` in `signalJobFinished` (keep only if it matches the
identifier regex, else omit) — and consider making `buildEvent` drop the
offending *prop* rather than the whole event.

---

## CRITICAL — the scrubber leaks a username containing a space

### C0. Any Windows account name with a space leaks its tail — through the log that ships in the support bundle

The scrubber is the milestone's P0: nothing reaches the log, telemetry, or a
bundle without passing it. Three rules are meant to cover the username. On an
account whose profile is `C:\Users\Dana Whitfield`, **all three fail together** for any
spelling not immediately followed by a slash:

- `homedirPattern` ends with `(?=[\\/]|$)` — a quote or a space after the path defeats it.
- `WIN_PROFILE`'s capture class is `[^\\/\s"'<>|:*?]+` — `\s` is negated, so the capture **stops at the space** and only the first name is replaced.
- `userPathRe` carries the same lookahead **and** runs *after* `WIN_PROFILE` has already rewritten `\Dana` → `\<user>`, so the literal it searches for no longer exists.

The "two independent mechanisms" the A1 red-check credits are not independent
here: the first destroys the second's input.

Verified by importing the real `createScrubber` and running it:

| shape | account `Dana Whitfield` | control `danawhitfield` |
|---|---|---|
| plain path, separator follows | caught | caught |
| `JSON.stringify({dir})` | **LEAK** — `C:\Users\<user> Whitfield` | caught |
| quoted at end (`EPERM scandir '…'`) | **LEAK** | caught |
| prose, space follows | **LEAK** | caught |

The control isolates the space as the sole cause. All three leaking shapes are
ordinary: `logError` does `JSON.stringify(extra)`, `scrub()` itself
JSON-stringifies objects, and Node prints quote-terminated paths in
`EPERM`/`EACCES`/`scandir` messages.

**Why it matters:** every line reaching `callrise.log` goes through this, and
`log.ts` states that file "is one a user emails to support, so it is an egress" —
the support bundle copies and ships it. Telemetry-over-the-wire is largely safe
because stack-frame paths are always followed by `\`; **the log and the bundle
are not.**

**Why no test caught it:** the suite has 24 scrubber cases and none uses a
profile name with a space — because this dev machine's account is literally
`User`. The bug is invisible for an environmental reason, not an oversight in
rigour.

**Fix shape:** drop `\s` from `WIN_PROFILE`'s capture class (or add a
space-tolerant variant), and either widen the home-dir lookahead to
`(?=[\\/"'\s]|$)` or run `userPathRe` **before** `WIN_PROFILE`. Red-check with a
fixture username containing a space.

---

## CRITICAL — data loss

### C1. An empty local `memory.db` defeats the restore guard, then the next sync overwrites the cloud Sales Brain with it

`backup.ts:537` — the M25 "never overwrite local" invariant is an **existence**
test, not a content test:

```ts
await fs.access(dbPath)
return // already have a local copy — never overwrite it from the cloud
```

`db.ts:129` creates `memory.db` *before* anything can fail — the WAL pragma and
`loadExtension` (the documented clean-Windows `ERR_MOD_NOT_FOUND` class) both
throw *after* the file exists. So a failed init leaves an empty husk that the
guard reads as "local truth worth protecting."

Then `backup.ts:512` uploads with **`upsert: true`** and no size, row-count, or
newer-than-cloud check.

**The sequence, on a new machine:** install → sign in → Sales Brain init fails or
simply starts empty → user goes to Settings and turns **on** Sales Brain backup,
precisely to get their brain back → restore sees the file and returns → upload
snapshots the empty DB and overwrites `<uid>/memory.db`. Supabase Storage upsert
has no version history. **The single cloud copy is destroyed by the act of
enabling the backup.**

The stopgap doc already tells the *human* restorer to "delete any `memory.db`…
(a fresh install's empty ones)" — the code cannot make the distinction we
instruct the person to make.

**Fix shape (two independent gates):** make the restore guard content-aware
(zero memory rows or unopenable = "no local copy"); and refuse to *upload* a
zero-memory snapshot while a non-trivial cloud object exists. The destructive
upsert is the irreversible half, so the push-side check matters most.

---

## CRITICAL — prime directive

### C2. The BUG-090 fix destroys telemetry on a 404 — and 404 is the day-one condition

`flush.ts:116` is a blanket range test with no allowlist, no `Retry-After`, and
(by design) no backoff — so the next flush repeats the destruction immediately:

```ts
if (result.status !== null && result.status >= 400 && result.status < 500) {
  ackSent(...)   // same call the SUCCESS path uses — the events are gone
```

Three reachable 4xx codes are transient, not permanent:

| code | why it happens | current behaviour |
|---|---|---|
| **404** | `telemetry_events` does not exist yet; PostgREST also 404s while reloading its schema cache after any DDL | batch destroyed |
| **429** | Supabase gateway / CDN throttling — means "retry later" by definition | batch destroyed |
| **408** | a proxy timing out a slow 100-event body | batch destroyed |

Verified: `default-config.ts:11` bakes in a live project; `index.ts:184` wires
ingest unconditionally; `index.ts:642` starts the schedule unconditionally. The
only gate is consent. The SQL has never been applied anywhere.

**So:** cutover ships, user opts in, 30 s later the first flush 404s and deletes
the batch. Every 6 h another 100 events are destroyed. When the SQL is finally
applied a week later, **that week is already gone.** Under the old code those
events would have waited in the queue and gone out intact.

This is the milestone's premise inverted, firing in exactly the window this repo
has been burned by three times (BUG-083, BUG-084, BUG-087: repo SQL ≠ deployed
schema). Note 429 makes it degrade *worst under adoption*.

**Fix shape:** invert the test. Retry with backoff on `408, 425, 429`, and on
`404` (a missing table is a deployment state, not a bad batch). Drop only codes
genuinely about *this payload*: `400, 409, 413, 422`. Honour `Retry-After`.

I red-checked this fix against a 400 and a 503, as asked. I did not consider
404/429/408 — the red-check was real but the classification behind it was wrong.

### C3. `telemetry-sent.jsonl` survives opt-out — and an in-flight send can create it *after* opt-out

`consent.ts:91-96` off-branch deletes the anon id and clears the queue. It never
calls `clearSent`. Verified: `clearSent` is reachable only from the manual
Settings button. `resetConsent` has the identical gap.

Each row holds the exact POSTed body including `anon_id`, `session_id`,
`os_version`, `arch` — so the install id the opt-out just deleted survives on
disk, and a later opt-in mints a new one, putting **both** ids in one file. The
stated "no continuity across consent" invariant is false on disk.

Worse: `flush.ts:74` reads consent *before* `await sendBatch` (up to 15 s), and
`appendSent` at `:100` never re-checks. Toggle off during that window and the
file is **created after revocation**.

Mitigating: the sent log is not in the support-bundle allowlist, so there is no
egress path — the exposure is local disk only.

**Fix shape:** call `clearSent` in both off-paths; re-read consent after the
await and skip `appendSent`/`ackSent` if it flipped; hold the `AbortController`
in module scope so opt-out can abort an in-flight send.

### C4. A failed opt-out write fails toward ON, and skips the deletions entirely

`consent.ts:80-96` — the `catch` returns *before* the side-effect block:

```ts
} catch {
  return readConsent(userDataDir)     // ← returns here
}
if (consent === 'on') { getOrCreateAnonId(...) }
else { deleteAnonId(...); new TelemetryQueue(...).clear() }
```

On an opt-out whose write fails (EPERM/EBUSY from an AV scanner, roaming
profile, full disk): the file still says `'on'`, the id is not deleted, the
queue is not cleared, `isEnabled()` keeps returning true, and sending continues.
The Settings toggle flips back to on with no error text anywhere.

My own docblock two lines above says a write failure "leaves the previous state,
**which is always the safer one**." True for opt-in; false for the direction
that matters.

Same root cause on the ask card: it does not inspect what was persisted, so a
failed write hides the card while disk stays `unasked` — the decision is lost and
the user is asked again next launch.

**Fix shape:** run the off-side deletions regardless of write success; return an
explicit failure the renderer surfaces instead of rendering stale state.

---

## HIGH — trust violations

### H1. Turning auto-update OFF after an update has downloaded does not stop the install

Verified: `autoInstallOnAppQuit` has exactly two assignments — `updater/index.ts:141`
(false at startup) and `:252` (inside `update-downloaded`). `applyAutoUpdatePreference`,
the only thing that runs when the toggle changes, never touches it.

So: update downloads at 09:00 (flag → true). User sees "restart to install",
decides they don't want this, flips auto-update **off** at 11:00. Flag stays
true. They quit at 18:00 → 1.4.0 installs silently. The Settings copy says "Turn
it off here anytime." The one window where the toggle is most likely to be used
is the window where it does nothing.

electron-updater re-reads the flag inside its quit handler, so a late `false` is
honoured — **the fix is one line** in `applyAutoUpdatePreference`.

No test covers it: the updater suite pins `isAutoUpdateEnabled: () => false` for
the whole file, so line 252 is only ever exercised in the false direction.

### H2. A cloud-settings pull can turn auto-update back ON where the user turned it off

Verified: `applyPulledSettings` protects exactly one field —

```ts
next.syncScope = current.syncScope
```

with a comment explaining that what leaves this machine is a *per-device*
decision. `autoUpdateEnabled` gets no such protection; it falls through the
generic merge, and the pushed payload is the entire settings object, so the key
is always present. The pulled value is then wired straight into the live updater
— the background timer starts immediately, no restart.

**Two devices, settings sync on:** user turns auto-update off on the laptop
(metered tethering). Two days later they change an unrelated setting on the
desktop; the whole blob pushes. The laptop pulls, merges `true`, and starts
downloading and installing updates. The toggle they set is back on, silently.

The migration contract's own words are "the user's own choice is never
overridden again." The forward-only marker guards the pre-migration case; nobody
guarded the simpler post-migration one.

**Fix shape:** same treatment as `syncScope` — `next.autoUpdateEnabled = current.autoUpdateEnabled`.

### H3. Running any pre-1.3.4 build once strips the migration marker

`mergeSettings` and `loadAppSettings` both rebuild a closed object literal, so an
old build does not merely ignore `autoUpdateMigratedToDefaultOn` — it **deletes
it from disk** on the first settings write (and `contacts.ts` writes settings
with no user action at all).

This is the runbook's own halt path: a user takes a bad staged release,
reinstalls 1.3.3 (which the runbook says not to delete), adds one contact — and
their deliberate `autoUpdateEnabled: false` becomes indistinguishable from a
legacy pre-decision false. The next upgrade overrides them **a second time** and
re-shows the "we now keep CallRise up to date" notice as if it were the first.

"Overridden exactly once, ever" is the entire honesty argument of the flip.

**Fix shape:** stop inferring "never migrated" from an absent key — a sidecar
file an old build never rewrites is the cheap option.

### H4. A dropped telemetry batch is reported as *"Still queued; will retry later"*

`TelemetrySection.tsx:53-55`:

```ts
if (r.attempted && r.sent > 0) return `Sent ${r.sent} event…`
if (r.attempted) return `Could not send (${r.reason}). Still queued; will retry later.`
```

`attempted && sent === 0` is precisely the drop case. So "Send now" reports
"Still queued; will retry later" for events already deleted and never retried.

And nothing persists it: `appendSent` runs only on success, the only signal is a
`console.warn` that goes nowhere in a packaged app, and `flush.ts` does not
import the repo's own persistent logger — so the drop never reaches
`callrise.log` or the support bundle. Scheduled flushes discard the result.

This is the milestone's transparency surface making a false factual claim about
the user's data.

### H5. The snapshot read failure is swallowed in total silence — and the backup then reports clean

`backup.ts:504-510`:

```ts
try { data = await fs.readFile(snapshotPath) }
catch { return }                                    // no log, no signal, no state
finally { await fs.unlink(snapshotPath).catch(() => {}) }
```

The sibling failure eleven lines up does both `console.error` and
`reportBackupStep`. Because this `return`s rather than throws, `pushAll` falls
through to `writeState({ lastPushAt: now, lastPushError: undefined })` and
returns ok. An AV scanner holding the just-written snapshot (EBUSY on a file
created milliseconds earlier) makes this fail every sync: Settings shows "Backed
up just now", forever, while the Sales Brain has never been uploaded.

This is BUG-087's exact shape — a swallowed error hiding a total backup failure
— reintroduced inside BUG-088's own fix. The module's own header promises the
opposite: "a step that fails for everyone forever is a dashboard row, not
archaeology."

### H6. An empty export reports success, and 0 bytes renders as "1 KB"

`snapshotMemoryDb` returns `ok: true` for any file SQLite opens, including an
empty husk. The renderer floors it:

```tsx
`Exported to ${r.path} (${Math.max(1, Math.round((r.bytes ?? 0) / 1024))} KB)`
```

`Math.max(1, …)` actively converts the one number that would expose an empty
export into a plausible "1 KB". On a machine where Sales Brain init failed, the
user is told they hold a disaster-recovery copy of a brain that is only in the
cloud. The *corrupt* case is honest (`SQLITE_NOTADB` → `snapshot-failed`); the
*empty* case is not.

This retires the founder's quit-and-copy ritual on a false green.

### H7. A failed export destroys the previous export at the same path

better-sqlite3 auto-deletes a partial backup **only when it created the
destination** (`isNewFile` → `unlink`). The export writes straight to the user's
chosen path with no temp-then-rename and no cleanup on failure.

So re-exporting over `E:\SalesBrain.db` on a USB stick — the workflow the
button's own copy recommends — and pulling the stick mid-copy leaves the
*previous good export* truncated under the expected name, while the UI says
"Export failed — try again."

This codebase already solved this: `atomic-write.ts` exists and says so. The
export is the one durability-critical write that bypasses it.

### H8. The native-crash marker survives opt-out, so crashes from the off-window are reported on re-consent

Verified: no deletion path exists anywhere (constant, setup read/write, and one
test asserting it *exists*). `crashReporter` runs unconditionally, so dumps
accumulate while consent is off. On re-consent, `recordLaunch` sees the stale
marker and counts every dump since — a measurement of the window the user said
no to. The module already knows this is wrong; it baselines at *first* consent,
just not at re-consent.

### H9. `setConsent` can throw despite its "Never throws" contract

`getOrCreateAnonId` sits outside the try. If the id write fails, consent is
already `'on'` on disk, the throw escapes through an IPC handler with no catch,
the renderer has no catch either — so the toggle stays visually OFF while the
queue fills and flush returns `'no id'` forever. Disk says on, UI says off.

---

## HIGH — entitlements (inert today; these bite the day enforcement flips)

### E1. The structural isolation guarantee is regex-bypassable and does not follow the import graph

My memo claims the test "greps the entitlements module's import graph." It greps
*file text* in one directory and never resolves an import. Proven empirically:

| import form | result |
|---|---|
| `from '../flags'` | CAUGHT |
| `from '../remote-flags'` | **BYPASS** |
| `from '../flags/index'` | **BYPASS** |
| `await import('../flags')` | **BYPASS** |

`../remote-flags` is the name the memos themselves use throughout. A *transitive*
path (`entitlements/index.ts → ../auth → ./google → flags`) also stays green.
Also verified: `flags-cannot-reach-privacy.test.ts`, cited in my memo as existing
precedent, **does not exist**, and no flags module exists either.

This is the one guarantee the founder asked be closed structurally rather than by
intention. It is currently closed by intention.

**Fix shape:** resolve the transitive relative-import graph and match on resolved
paths, not import-string spelling. Land a deliberately-failing version first.

### E2. System-clock rollback grants unbounded free Pro; `cachedAt` is written but never read

Only time source is `Date.now()`. Verified: `cachedAt` is declared at
`store.ts:24`, written at `:51`, and **read nowhere** — the one field that could
bound rollback is dead. Pay for one month, set the clock back, keep Pro forever.

### E3. No revocation, no freshness — and `isInForce`'s docblock contradicts its code

The claim carries no `iat`, `nonce`, or version, and nothing ever refreshes a
token (`cacheVerifiedToken` has zero callers outside the module). Worse, verified
directly:

```ts
/* A `canceled` or `none` status is never in force regardless of dates — ... */
export function isInForce(ent, now) {
  if (ent.status === 'none') return false
  if (ent.currentPeriodEnd === null) return ent.status !== 'canceled'
  return now <= ent.currentPeriodEnd + OFFLINE_GRACE_MS   // status never consulted
}
```

Canceled + dated **is** in force; `past_due` is never consulted. My test file
covers canceled+perpetual and none+dated and misses exactly canceled+dated.

For a perpetual licence the same gap means a refunded buyer keeps a
cryptographically valid Pro token forever, with no revocation channel of any kind.

### E4. Flip day denies every paying user, and the 14-day grace is unreachable in the case it exists for

`resolveEntitlement` returns `null` when there is no signed-in user *or* no
cached token, and `null` is a hard deny. Nothing has ever called
`cacheVerifiedToken`, so on flip day **no machine has a token** — every gated
feature off for every payer, silently.

And the grace window is gated behind `getSignedInUserId()` succeeding first,
which collapses "couldn't determine" into the same `null` as "signed out." The
"keeps working on a plane" promise never executes offline.

### E5. The claim is type-*asserted*, not validated — and my SQL and my types disagree on units

Only `userId` is checked, then `as Entitlement`. Verified: the SQL declares
`current_period_end timestamptz`; `types.ts` declares epoch-ms `number`. The
webhook (unwritten) is the only thing between them. Empirically:

| value | result |
|---|---|
| `"2026-09-24T00:00:00+00:00"` | `inForce = false` → **every payer locked out** |
| `"1756000000000"` | `inForce = true` until **year ~2525** |

Both fail silently, and no test can catch it because every test constructs the
claim in TypeScript.

---

## HIGH — the support bundle is materially broken on every real install

### S1. The scrubber's 4096-char cap truncates whole bundle files into invalid JSON

`support-bundle.ts:90` and `:115` hand a **whole serialized file** to `scrub()`,
which was built for single log lines and telemetry fields and caps at
`DEFAULT_MAX_LENGTH = 4096` (verified: the app-wide instance is built with no
`maxLength`).

Measured by replaying the exact bundle transform over the founder's live
`sales-os` directory:

| output | real size | cap | result |
|---|---|---|---|
| `ai-purpose-health.json` | **6,297 chars** (13 purposes) | 4096 | `JSON.parse` fails — **4 purposes vanish** |
| `jobs-summary.json` | **10,779 chars** (47 jobs) | 4096 | `JSON.parse` fails — **18 of 47 jobs survive** |

This is not an edge case: `emptyHealthMap` writes *every* purpose
unconditionally, so the health file exceeds 4096 on **every install that has
ever made one AI call**. Jobs overflow past ~19.

The purposes that get cut are the memory ones — exactly the ones behind BUG-057
("Sales Brain learned nothing"), BUG-080 and BUG-082. A user hitting today's most
common failure clicks the support button and the one file that would show it
arrives truncated, unparseable, and missing precisely the affected records.

**Why the test is green:** the fixture plants **one** purpose (~460 chars) and
**one** job (~180 chars) — an order of magnitude under the cap.

**Fix shape:** never length-cap a whole file. Scrub per record before assembly
(as `scrubbedFallbackLog` already does), or use a `createScrubber({ maxLength: Infinity })`
for file-sized payloads. Red-check with a 13-purpose / 40-job fixture asserting
`JSON.parse` round-trips.

### S2. `kern_bridge.prev.log` is a filename the engine never writes — the rotated log is collected by *neither* export

Verified against the engine source:

```cpp
g_logPath     = dir + L"\\kern_bridge.log";
g_logPathPrev = g_logPath + L".1";          // kern_bridge.log.1
```

`grep "prev.log"` across the engine source: **not found**. Our shared list
(`tier1-diagnostics.ts:31`) asks for `kern_bridge.prev.log`.

The live `kern_bridge.log` is 2,064,534 bytes against a 2 MB rotation threshold —
rotation fires on the next engine start. After it, the entire history of whatever
the user is reporting sits in `kern_bridge.log.1` and is picked up by **neither**
M27's diagnostics zip nor M29's support bundle; the bundle ships only the
near-empty current log.

I reused `engineDiagnosticFiles()` specifically so the two exports "can't drift."
They don't drift — they are wrong **together**. Both tests hard-code the wrong
name, written from the TypeScript's expectation and never cross-checked against
the C++ writer.

### S3. `BUNDLE_FILES` is never enforced at runtime — the "closed allowlist" does not constrain the code

`BUNDLE_FILES` is exported and never referenced by the builder (grep: the
declaration and two test lines). There is no runtime filter. The engine loop
copies whatever `engineDiagnosticFiles()` returns.

So adding a fourth entry there — the natural place, since that function is
documented as the *tier1* privacy claim and its review is scoped to the
diagnostics zip — silently ships that file in support bundles. **The allowlist
test still passes**, because the fixture only creates the three known files, so
the new one is simply absent from the produced set.

The guard is a set-equality assertion over whatever the fixture happened to
create, not a constraint on what the code may write.

### S4. Every job id is scrubbed to the literal `<uuid>`; the test hid it with a non-UUID id

The scrubber's UUID rule fires on the whole serialized array. Verified against
live data: **47 of 47** job ids are UUID-shaped, so every row reads
`"id": "<uuid>"`. Combined with S1, `jobs-summary.json` in practice is 18 of 47
rows, all anonymous, terminated mid-object.

The fixture plants `id: 'job-1'` and asserts it survives — proving id
preservation using the one id format the app never generates.

### S5. `backup-state.json` is embedded verbatim while the module header claims its prose is stripped

My header says free-text including *"backup error prose"* is
`STRIPPED — not scrubbed, absent`. The code pushes the whole file into the
summary and relies on `scrub()` — which preserves prose **by design**.
`lastPushError` is fed by 11 sites re-throwing raw Supabase/PostgREST messages.

Every other content-bearing field here is stripped rather than trusted to the
scrubber. Backup's provider prose is the single exception, and the header says
it isn't.

---

## MEDIUM — user-facing copy that contradicts the code

### U1. The Export card tells users to restore in the exact way BUG-089 was just fixed for

`SalesBrainSection.tsx:191`: *"…restoring is copying it back as memory.db."*

That instruction is precisely the hazard `removeWalSidecars` exists to prevent —
a stale `-wal`/`-shm` beside a restored `memory.db` makes SQLite replay a WAL
keyed to the *old* database. Either the DB fails to open (memories gone) or it
opens with mixed pages. Nothing warns them; the restore appears to work.

Species 16, twice over: the stopgap doc's own restore procedure says to delete
all three files first, and BUG-089 — fixed in the same commit — is the identical
omission in code. Worse, the *same file* at line 39 says "quit the app, copy
memory.db + its `-wal`/`-shm` files." **Two strings on one screen disagree about
whether the sidecars matter.** The code path was fixed; the instruction telling
a human to do the same operation by hand was not.

### U2. Turning diagnostics off says the install ID is deleted; the same screen then prints it

`TelemetrySection.tsx:147` promises "the queue and your install ID are deleted
immediately," and the ID row switches to `—`. But opt-out never clears the sent
log (C3), and every row there embeds `anon_id`, rendered verbatim one card down
under "View what's been sent."

The screen asserts the ID does not exist and prints it in the same scroll. On the
one screen whose premise is that "anonymous" is *checkable* rather than trusted.

### U3. The consent ask card hides itself without checking the decision persisted

`TelemetryAskCard` awaits `setConsent` and discards the returned record — which
main returns *as persisted* precisely so a caller can tell. `TelemetrySection`
does this correctly; the ask card does not. On a failed write the card
disappears (the only feedback there is), consent stays `unasked`, and the user is
asked again next launch after having said yes.

### U4. Both new buttons swallow a rejected invoke into a silent no-op

`AppSection` and `SalesBrainSection` use `try/finally` with no `catch`. The
loading state recovers, but no status string is ever set — the card reverts to
its marketing sentence as though nothing was clicked.

And `buildSupportBundle` is carefully total, but its arguments are evaluated
**outside** it:

```ts
const result = await buildSupportBundle(
  { userDataDir: app.getPath('userData'), ... },
  app.getPath('downloads')          // ← throws here, outside the try
)
```

`app.getPath('downloads')` throws on a redirected/offline known folder — a real
corporate-profile shape. On that machine the written fallback copy ("Could not
create the support bundle — try again…") **can never render**, because it only
runs when the promise resolves with `ok:false`. A user on exactly the kind of
broken machine support bundles exist for gets nothing at all.

Related: the builder returns `err.name` (always `'Error'`), discarding
`err.code` where `ENOSPC`/`EACCES` lives — so the feature built to tell support
what went wrong cannot say what went wrong with itself. It also has no cleanup on
failure, unlike M27's diagnostics export, so a mid-write failure leaves a
half-built folder that the collision loop then walks past forever.

---

## Tests that do not discriminate (hollow green)

1. **The live-handle branch of `snapshotMemoryDb` can be deleted and every test still passes.** Both suites mock `getMemoryDb → null`, so no test reaches the live branch through the door production uses; the one test that names it passes `liveDb` explicitly and asserts output the fallback produces identically. `uploadSalesBrainDb` calls with no deps — the mocked-away resolver **is** the shipped path for BUG-088's fix.
2. **Privacy invariant 4 enumerates 13 literal filenames; the directory has 14.** `signals.ts` (added in A2, after the suite was written) is unchecked — adding `import { getSignedInUserId } from '../auth'` to the module every subsystem calls would keep it green. It is also the only invariant with **no recorded red-check** in the claim-audit table.
3. **The schedule test asserts a timer *count* only.** Replace both callback bodies with no-ops and it stays green — production would never send a byte automatically. The test's name claims "timers are unref-ed"; nothing inspects unref.
4. **`signalNativeLoad` is suppressed by an un-reset once-guard**, so "firing every signal writes nothing" silently fires 9 of 10. `resetNativeLoadSignalForTests` exists and is called nowhere. `native.load` is the most-wired signal and A2.5 recorded no per-signal red-check.
5. **`FEATURE_IDS` is never pinned to the `NavId` union it claims to mirror.** Add a nav section, forget the main-side set, and it is invisible in every usage report with all tests green — already live given M28's "Rise" section is mid-merge and the suites contain `feature.rise.opened` as a fixture while `FEATURE_IDS` has no `'rise'`.

Also worth naming: `privacy-invariants.test.ts` asserts
`telemetryFiles.length >= 3 // id, consent, sent log` — the suite **encodes** the
sent-log-survives behaviour that C3 shows is a prime-directive violation.

---

## Development items (not bugs)

**Buildable now, blocked on nothing:**
- **The branch is not on origin** and is 39 commits ahead of `main`. No off-machine copy of the milestone. Pushing is not releasing.
- **`schema_versions` is stamped by 1 of 6 SQL files** (verified: telemetry 3, all others 0) — and the runbook's GO-gate probe cannot read the table anyway, because the telemetry SQL does `revoke all on public.schema_versions from anon, authenticated`. The gate designed to turn "provisioned" from memory into evidence is neither populated nor runnable.
- **The rollout runbook still says "Auto-update is OFF by default"** and "a bad version cannot be pushed out." After 1.3.4 every sentence in that paragraph is backwards — and it is the paragraph read while deciding whether to ramp or halt.
- **No `TELEMETRY_BACKEND_LIVE` gate**, though this branch's sibling fix invented exactly that pattern for the identical failure (`ALERTS_BACKEND_LIVE`, BUG-083).
- **`main` is 4 commits past `v1.3.3` and still declares 1.3.3**, so a build from main can never be offered to anyone on 1.3.3 (`not-newer` refusal) — and that refusal now emits telemetry, so the first data read would be dominated by a self-inflicted version mistake.
- **BUG-081 (dead Groq default model)** is unblocked and one verified model id; once telemetry has a destination it becomes the loudest row in cutover week.
- **`CLAUDE.md` is still stale** about `device-owner.ts` / `device-reset.ts`, deleted 2026-08-11. Flagged in the Phase 0 audit; survived the whole milestone. Species 18, in the file that is auto-loaded first.
- **The migration memo says "all four SQL files" then lists five.** A one-word drift in the checklist a human executes under pressure, for the exact failure class the migration exists to cure.

**Blocked on the M28 merge:**
- **`signalRetrievalQuery` has zero callers** (confirmed) — the BUG-080 detector. A sweep of every added line found no *other* hidden deferral; this is the only one of its kind. Merge order measured, not guessed: M29 → main is a **fast-forward**; M28 → main conflicts on exactly two files (`catalog-ipc.ts`, `rag.ts`), unchanged by merging M29 first.

**Blocked on the founder:**
- Real user count; the new project + SQL + the `telemetry_prune()` cron (which the SQL only *comments*, so the `schema_versions` receipt cannot prove it); the clean VM (the RAMP restore test is the only exercise BUG-089's fix ever gets against its real trigger); tagging.
- **BUG-087's exposure is linear in delay** — every week without the cutover is a week the Sales Brain exists on one disk, protected only by remembering the manual stopgap.
- **BUG-085's urgency rose:** the fresh-start cutover routes **100% of existing users** back through the never-walked sign-up path, with contradictory key copy — and collides with the cutover notice's "don't press Sign out," the one button that wipes API keys.

---

## Checked and found genuinely clean

Recorded so nobody re-audits: consent is genuinely absent from the cloud-backup
payload (verified by reading what is serialised, not the comment); no recording
before consent is read; the *send* side of off-means-off is correct; transport
carries the public anon key only with `credentials: 'omit'`, no session JWT;
duplicate sends are idempotent (`on_conflict=event_id` + a real unique
constraint); queue eviction cannot discard newer events and no single event can
wedge it; concurrent flushes share one in-flight promise with no timer leak;
network errors (`status: null`) correctly take the backoff path; concurrent Sales
Brain snapshots are genuinely serialised; a corrupt source DB fails honestly; the
CI staged-rollout verification is real (re-downloads and greps an anchored
pattern, fails the build); `policy.ts` has no branch where a failure reads as a
pass; the BUG-088/089 fixes themselves are genuine and their WAL fixture
discriminates. On the entitlements side: bytes-verified equal bytes-parsed,
prototype pollution unreachable, algorithm confusion fails closed, cross-user
replay correctly rejected, empty key fails closed first.

The scrubber, capture, and BUG-090 suites were specifically examined for hollow
greens and found to discriminate — controls prove the raw input carried the
thing, `Object.keys` is pinned exactly, and the job-telemetry test sets
`cancellable: true` *and says why*.

---

# Appendix — the species 26 citation audit (2026-08-24)

Founder's instruction after species 26 was named: *"audit the rest of the M29
docs for other citations to things that may not exist. You found one by
accident. If any other memo, runbook, or claim-audit row cites a test file, a
helper, a deployed function, or a guarantee, open each one and confirm it's
real."*

Method: mechanically extract every backticked file path, every `fn()` citation
and every snake_case object name from all 15 M29 docs (3,506 lines), then check
each against the actual tree, `node_modules`, the SQL files and the CI
workflows. **223 file citations, 12 function citations, 31 object names.**

## What survived

| class | count | verdict |
|---|---|---|
| real files in the repo | 166 | resolve exactly |
| library files (`node_modules`) | 11 | real; citing electron-updater internals is legitimate |
| runtime data files (`%APPDATA%`) | 21 | correct — they exist on a user's machine, not in the tree |
| build/release artefacts | 10 | correct — `latest.yml`, installers, `dist/` |
| **path drift** (exists, cited at the wrong path) | **0** | — |

## What did not survive

**Correct in context — cited precisely *because* they don't exist** (7):
`device-owner.ts` / `device-reset.ts` (cited as deleted, in the CLAUDE.md
staleness finding), `CHANGELOG.md` and `docs/1.2.x-release-note.md` (cited as
absent, in "What's New does not exist"), `hostile-identities.ts` (a *proposal*
in the fix-shapes doc), plus two brace/regex artefacts
(`{Windows,Mac}Adapter.ts`, a bare `.exe`).

**Genuine defects — corrected in this commit** (6):

| # | doc | cited | reality |
|---|---|---|---|
| 1 | `M29-A1-plan.md` | **`buildOutbound()`** — "every byte… same function… no second path" | **Does not exist, and the claim is false.** See below — it was hiding a real gap. |
| 2 | `M29-A1-plan.md` | `crash_free_sessions_by_version` | the view is `telemetry_version_health` |
| 3 | `M29-B2-entitlements-memo.md` | `flags-cannot-reach-privacy.test.ts` as precedent | does not exist (the original species-26 instance — **documented as a finding but never corrected at the source until now**) |
| 4 | `M29-remote-flags-memo.md` | same file, described in the **present tense** | the root that made #3 possible; now marked NOT BUILT |
| 5 | `M29-alerts-decision-memo.md` | `schema_version` | the table is `schema_versions` |
| 6 | `M29-audit.md` | `kern_bridge.prev.log` | the engine writes `kern_bridge.log.1` |

## The one that mattered: `buildOutbound()` → BUG-094

The A1 plan asserted that telemetry, the support bundle and the diagnostics zip
all go through one scrubbing function, and named it. Checking the name found
nothing — and checking the *claim* found a real privacy gap:

| egress path | scrubbed? |
|---|---|
| telemetry | yes — `scrub` inside `buildEvent` |
| support bundle (A5.4) | yes — per line, and `scrubDocument` per file |
| **M27 diagnostics zip** | **no — `copyFileSync` raw; the module never imports the scrubber** |

`grep scrub src/main/tier1-diagnostics.ts` returns nothing. The zip ships
`kern_bridge.log` byte-for-byte — logs this milestone's own Phase 0 audit
records as carrying `C:\Users\<name>\…` — plus `enginePath` and the renderer's
`deviceLabels` (mic names often contain a person's name). Logged as **BUG-094**,
🟠 High, not fixed, best batched with BUG-093 so one hostile-fixture set covers
both egress paths.

**Why this is the species-26 mechanism exactly:** a reviewer auditing egress
would grep `buildOutbound`, find nothing, and — being quick — assume a rename
rather than an absence. The phantom name was *more* protective of the gap than
a weak real function would have been, because a weak real function invites you
to read it.

## What this audit did not cover

Prose guarantees with no citable identifier ("the transport carries the anon key
only") were not machine-checkable and were left to the sweep's own verification.
Vault documents outside `docs/` were out of scope. And this audit checks
*existence*, not *correctness*: a cited file that exists but does something
other than advertised is species 26's other half, and only reading it catches
that — which is how #1 was found.

---

# Appendix 2 — the CORRECTNESS audit of high-stakes claims (2026-08-24)

Appendix 1 checked whether cited things **exist**. This checks whether they
**do what the citation says** — species 26's other half, which no script finds.

Founder's scoping, because reading every claim is unbounded: *"for the
highest-stakes claims only — the ones asserting a privacy or safety invariant
… where being wrong means a leak or a data loss. Name which claims those are,
check them, and report."*

## The selection rule

A claim qualified if being wrong would mean **user content or identity leaving
the machine**, or **user data being lost**. That is 11 claims. Everything else
— performance, ergonomics, "this is cleaner" — was excluded by design.

## Result: 9 hold, 2 do not

| # | Claim | Where asserted | Verdict |
|---|---|---|---|
| 1 | Nothing reaches the local log without passing `scrub()` | `scrub.ts` header | ✅ **HOLDS** — `log.ts:46` `const safe = scrub(line)` then writes `safe`; the only other write is an empty touch. No bypass. |
| 2 | `crashReporter` never uploads; minidumps are counted, never sent | A1.2 / audit | ✅ **HOLDS** — `index.ts:87` `crashReporter.start({ uploadToServer: false, compress: true })`. Minidumps contain process memory, so this was the highest-consequence single line in the set. |
| 3 | The transport carries the **public anon key only**, never the session JWT | A1.4 | ✅ **HOLDS** — `ingestHeaders` sets `apikey`/`Authorization` from `cfg.anonKey`, and `index.ts:184` sources it from `SUPABASE_ANON_KEY`. No JWT path. |
| 4 | Identity separation is **physical** — no import path from telemetry to auth/settings/backup/supabase-js/updater | A1.6 invariant 4 | ✅ **HOLDS IN FACT** — I read the imports of all **14** telemetry files: only node builtins, sibling telemetry modules, and `electron` (in `ipc.ts`). `signals.ts` — the file the test forgets — imports only `./index`. **But the guard is weak:** the test enumerates 13 filenames. The guarantee is true today; nothing reliably keeps it true. |
| 5 | Error events carry class + frames, **never** the message | A1.2 | ✅ **HOLDS** — `errorEventProps` builds `{scope, errorClass, code?, stack?}`; `code` is regex-gated to `[A-Za-z0-9_.-]{1,64}`; `stack` is reduced to `at …` frames. The message has no path in. |
| 6 | `props` cannot hold an object — no structure can ride an event | A1.1 | ✅ **HOLDS** — `PropValue = string \| number \| boolean`, and `buildEvent`'s final `else` rejects objects, arrays, null, bigint, symbol and functions by name. |
| 7 | Telemetry consent is **never** in the cloud-backup payload | A1.3 | ✅ **HOLDS** — the backup upserts `loadAppSettings()`, and `AppSettings` has no telemetry key. The only `consent` hits in `app-settings.ts` are comments about *call* consent, a different subsystem. |
| 8 | `writeJsonAtomicSync` is genuinely atomic and verified | M26 / used by settings + jobs | ✅ **HOLDS, and exceeds the claim** — temp write → `JSON.parse` verify → `fsync` (with the Windows `'r+'` nuance handled) → `rename` → directory fsync on non-Windows → temp unlinked on any failure. |
| 9 | `allowDowngrade = false` and `autoDownload = false` (so our gate stays authoritative) | §5.3 / auto-update memo | ✅ **HOLDS** — `updater/index.ts:140,144`. |
| 10 | **All egress goes through one scrubbing function** (`buildOutbound()`) | `M29-A1-plan.md` | ❌ **FALSE** — the function does not exist and the M27 diagnostics zip scrubs nothing. **BUG-094.** |
| 11 | **Every** best-effort backup sub-step failure counts into the aggregate signal | `backup.ts:54-56` header | ❌ **FALSE** — the Sales Brain snapshot-read catch (`backup.ts:506`) is a bare `return` with no `reportBackupStep`. Already logged as sweep finding H5; now also recorded as a **false doc claim**, not merely a missing call. |

## The pattern in the two failures

Both are the same shape, and it is worth naming separately from species 26's
existence half: **a header asserting complete coverage ("no second path",
"every sub-step"), with an uncovered path.** Neither was a lie — both describe
the design accurately. What drifted is that the design grew a third path
(#10) or a new early-return (#11) and the totalising sentence was never
revisited.

Practical consequence: **treat the words "every", "all", "no second", "always"
in a privacy or safety claim as load-bearing assertions that need a
enumeration, not as emphasis.** Both failures here would have been caught by
one question — *"list them"*.

## What this did not cover

Prose guarantees with no citable identifier, anything requiring the live
Supabase project or a running app, and the ~200 non-safety claims excluded by
the selection rule. The eleven above are the set where being wrong means a
leak or data loss; that boundary is the audit's own claim, and it is the thing
to challenge if it looks too narrow.
