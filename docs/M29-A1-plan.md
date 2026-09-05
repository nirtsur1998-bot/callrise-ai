# M29 Workstream A1 — build order

**Date:** 2026-08-23. Approved direction from the founder: the scrubber is
P0 and first; remote flags deferred until A1/A2/A4 are solid; pricing waits
for A3 data, so A1/A2 are built as the architecture A3 plugs into.

Each step is one commit, red-checked (the test is shown failing without the
code, for the right reason), and stated with its environment. Nothing
sends a byte until step A1.4, and nothing sends a byte *ever* unless the
user opted in (A1.3).

| # | Step | What it is | The red-check |
|---|---|---|---|
| **A1.0** | **Scrubber** — `src/main/telemetry/scrub.ts`, pure, no Electron import | One function `scrub(text) → text` that removes: user-profile paths in every spelling (`C:\Users\<name>\`, `C:/Users/…`, `file:///C:/Users/…`, `/Users/<name>/`, `/home/<name>/`, `%USERPROFILE%`), the literal `os.homedir()` and `os.userInfo().username`, API-key shapes (`sk-…`, `sk-ant-…`, `gsk_…`, `AIza…`, `pplx-…`, long bearer tokens), email addresses, UUIDs (could be the account id), URL query strings; caps length. **Applied by construction** at every egress — telemetry event builder, support bundle, diagnostics zip, and the local log writer (`log.ts`) — never by callers remembering to. | Plant `C:\Users\danawhitfield\AppData\Local\Programs\CallRiseAI\…` and an `sk-ant-…` key inside a real `Error().stack`; assert the output contains neither the username nor the key; then disable the path rule and watch **that** assertion fail. Second test: for every string the scrubber emits, `os.userInfo().username` and `os.homedir()` are absent — run on this machine where the username is real. |
| A1.1 | **Event model + local queue** | `TelemetryEvent { id, ts, kind: 'crash'│'error'│'health'│'usage', name, appVersion, os, osVersion, anonId, props }` where `props` values are **only** `string │ number │ boolean` — no nested objects, no arrays, no free text except `errorClass` and a scrubbed `stack`. Queue at `userData/telemetry-queue.jsonl`, capped (500 events / 1 MB, oldest dropped), readable over IPC. `anonId` from a new `userData/telemetry-id` (`randomUUID()`), created only when the user opts in, deleted when they opt out. | A test that tries to enqueue an event whose `props` contains an object or a 5 KB string is rejected at the type boundary *and* at runtime. A test that the queue file never contains the contents of `supabase-auth.json`'s email. |
| A1.2 | **Capture** — promote what exists | Main `uncaughtException`/`unhandledRejection` (replace the two duplicate handlers with one), `render-process-gone`, `child-process-gone`, renderer `error`/`unhandledrejection`/`ErrorBoundary` → `error` events with `errorClass` (constructor name or `.code`), scrubbed stack, `featureArea` derived from the scope string. Native crashes: `crashReporter.start({ uploadToServer: false })` writes minidumps locally — **minidumps contain process memory and are never uploaded**; at next launch the app counts new files in `crashDumps` and emits one `crash.native` counter. Retire `%TEMP%\callrise-startup-crash.log` (unbounded) into the same path. | A thrown error carrying a transcript-shaped string in its message arrives in the queue with the string gone (the scrubber is upstream). A forced `render-process-gone` (dev IPC) produces exactly one event. |
| A1.3 | **Consent** | `telemetry.consent: 'on' │ 'off' │ 'unasked'` in app settings. Asked once: an onboarding step for new installs, a one-time card for existing ones — honest copy listing exactly what is and isn't sent. Settings → new **Privacy & telemetry** section: the toggle, **"View what's been sent"** (renders the real payloads from A1.5, not a description), "Delete my telemetry queue." The app is fully functional with it off. | With consent `off` or `unasked`, a mocked transport receives **zero calls** across a launch + idle + quit cycle; flip to `on` and it receives one batch — the same test, both branches, so it is proven to discriminate. |
| A1.4 | **Transport** | Batched; sent 30 s after launch, on idle, and every 6 h; exponential backoff; offline → stays queued. A **separate, session-less** Supabase client (`createClient(url, anonKey)`, no auth storage) so the user's JWT can never ride along. Ingest posture decided with the founder (direct anon insert vs. first edge-function deploy — audit §2.4). | Intercept the outbound request: assert the `Authorization` header is the anon key and **not** the session's access token, and the body contains no `user_id`, no email, no `.updaterId`. |
| A1.5 | **Sent log** | `userData/telemetry-sent.jsonl` — the exact bytes of every batch that left, which "View what's been sent" renders. Capped. | The bytes in the sent log are byte-identical to what the mocked transport received. |
| A1.6 | **Privacy red-check suite** — `src/main/telemetry/__tests__/privacy-invariants.test.ts`, runnable forever after | (1) a transcript string planted in an error path never appears in any outbound payload; (2) opt-out sends zero bytes; (3) the telemetry id is not derivable from, stored beside, or sent with the account email — checked against the real `userData` layout; (4) no telemetry module imports `auth.ts` or reads `supabase-auth.json` (import-graph test). | Each invariant has a deliberately-broken twin that must go red. |
| A4.1 | **Version-health view** (SQL) | `telemetry_version_health` (this row said `crash_free_sessions_by_version` until the 2026-08-24 citation audit — that name was never created; the view in `supabase/2026-08-telemetry.sql:127` is `telemetry_version_health`) over the ingest table: sessions, crashed sessions, crash-free %, per `app_version`, last 7/30 days. Queryable in the dashboard; the runbook's Step 4 points at it. | Seed ten fake rows in a scratch schema, assert the percentages. |

Then **A2** (the signal set from audit §6, each a counter or enum, promoted
from `ai-purpose-health.json` / `jobs-state.json` / the updater and consent
sites that currently swallow), then **A3** (feature-usage counters with a
fixed allowlist of feature names), then **A4.2** (the zero-window CI change,
tested on a throwaway tag), then **A5** (support bundle — the scrubber is
already there by then).

## Things decided by the design, not per-feature

- **Egress goes through one function.** ~~Every byte that leaves the machine
  — telemetry, support bundle, diagnostics zip — is built by the same
  `buildOutbound()` that runs the scrubber and the allowlist. There is no
  second path.~~

  **CORRECTED 2026-08-24 by the species-26 citation audit. `buildOutbound()`
  does not exist and never did, and the claim it carried is false.** There are
  three egress paths, not one, and they do not share a mechanism:

  | path | scrubbed? |
  |---|---|
  | telemetry | yes — `scrub` inside `buildEvent`, applied to every prop |
  | support bundle (A5.4) | yes — `scrub` per line, `scrubDocument` per file |
  | **M27 diagnostics zip** (`tier1-diagnostics.ts`) | **NO — `copyFileSync` raw, no scrubber imported at all** |

  The third row is a real gap, not a wording problem: the zip ships
  `kern_bridge.log` byte-for-byte, and this audit's own §1.4 table records that
  those logs carry `C:\Users\<name>\…` paths, i.e. the username. Logged as
  **BUG-094**.

  This is exactly what species 26 predicts: a named-but-nonexistent helper is
  *more* convincing than a weak real one. Anyone auditing egress would have
  grepped `buildOutbound`, found nothing, and — if they were being quick —
  assumed a rename rather than an absence. The design intent below is still
  right; the claim that it was implemented was not.
- **Counters, not content.** `props` cannot hold an object. If a future
  signal needs structure, it becomes two counters, not a JSON blob.
- **Identity separation is physical.** The telemetry module has no import
  path to `auth.ts`; the ingest table has no `user_id` column; the transport
  client has no session. Tested, not promised.
- **Off means off.** `'unasked'` behaves exactly like `'off'`.

---

## Claim audit — A1 as built (2026-08-23)

Environment for every row: this Windows dev machine (username literally
`User`), worktree `callrise-m29`, fresh `npm ci`, vitest through
`scripts/run-tests.mjs` with the exit code captured by `$?` into a log and
read from there — never from a summary line.

| Step | Commit | Claim | Red-check performed (break → watch red → restore → green) |
|---|---|---|---|
| A1.0 | `13ee38f` | A stack containing `C:\Users\<name>\` arrives scrubbed; keys, JWTs, emails, UUIDs, URL queries, IPs redacted; never throws | `WIN_PROFILE` rule disabled → 5 tests fail naming the username → restored → 31/31. The real-machine stack test stayed green through it because the independent home-directory rule caught it (two mechanisms). |
| A1.0b | `b1ea078` | Every line of `callrise.log` passes the scrubber at the single write chokepoint | `scrub()` removed from `appendLine` → 3 fail naming the username → restored → 9/9 |
| A1.1 | `065c864` | `record()` writes zero bytes while disabled/unconfigured/throwing gate; props are primitives only; queue bounded; anon id separate | Consent gate removed from `record()` → "zero bytes while disabled" + "throwing gate fails closed" fail → restored → 50/50 |
| A1.2 | `92a9f6d` | Error events carry class + frames, never the message; renderer/child deaths counted; native dumps counted locally and never shipped | `stackFrames` made to keep the message line → 4 tests fail showing the planted transcript → restored → 70/70 |
| A1.3 | `f629426` | Consent is device-local (not in AppSettings → never backed up), asked once, 'on' mints the id, 'off' wipes id + queue, immediate | Setup's gate forced to `true` → 3 fail → restored → 73/73. Structural test: `app-settings.ts`/`backup.ts` never reference consent. |
| A1.4/5 | (this commit) | Transport is plain fetch with the anon key only; failures keep everything queued with 1m→5m→30m→6h backoff; the sent log holds the byte-identical body | Authorization header tampered → invariant 3 fails → restored |
| A1.6 | (this commit) | The privacy suite: transcript never leaves; opt-out sends zero bytes AND writes no telemetry file; id not joinable; no import path to identity | (1) whitespace allowed in token props → invariant 1 fails (2 tests); (2a) only the `record()` gate broken → still zero bytes on the wire, but the queue file appears on disk → invariant 2 fails on the *file* assertion — the suite is stricter than "zero bytes sent," correctly; (2b) both gates broken → fails; (3) header tampered → fails. All restored → 93/93. |

**Finding forced by A1.6 (and fixed in its commit):** the first version of
the event model allowed any ≤256-char string as a prop. The scrubber removes
*identifiers*; it cannot recognise *prose*, so a caller passing
`{ note: <transcript> }` or a raw `err.stack` as a prop got it through. Fix,
structural: ordinary string props must be **tokens** (`^[A-Za-z0-9_.:/@+-]{1,128}$`
— no whitespace, so a sentence is unrepresentable), and the one free-text
key, `stack`, is reduced to its `    at …` frames inside `buildEvent` for
every caller, not only inside `captureError`. A message with no frames
contributes nothing.

**Not claimed:** no real request has been made to the live Supabase project
(the SQL in `supabase/2026-08-telemetry.sql` has not been applied; the founder
applies it). The end-to-end "a row lands in the table" check is owed once it
is, and is the first thing to run after the paste: Settings → Privacy →
Diagnostics & telemetry → on → Send now → the row in the dashboard.

## Claim audit — A2/A3 as built (2026-08-24)

Same environment discipline as the A1 table. `docs/M29-A2-signals.md` maps
every signal to the real incident it exists to catch.

| Step | Commit | Claim | Red-check |
|---|---|---|---|
| A2.1 | `02507a9` | Closed signal catalog; a poller can't flood tier1.state; a free-text code is rejected rather than shipped | (catalog-level; per-source red-checks below) |
| A2.2 | `e74eb57` | AI failures/recoveries counted; `info.detail` (provider prose) never travels | detail wired in on purpose → the event VANISHES (token rule) → planted-content test red → restored |
| A2.3 | `17c59b5` | Every terminal job transition counts, silent jobs included; message never travels; progress ticks emit nothing | hook removed → both tests red; jobs suite 123/123 with the hook |
| A2.4 | `7b28d7a` | Update outcomes counted; refusal prose CLASSIFIED into codes | raw prose wired as the code → token rule kills the event → refused row missing → red |
| A2.5 | `bcbed31` | 18 backup sub-steps, 4 native modules (once per process), Tier 1 state (change-only) — failures rethrow, behaviour byte-identical | (additive at existing catch/error sites; full suite proves no behavioural change: 226 files green) |
| A2.7 | `5090482` | Consent-gate I/O failures counted; **every gate outcome byte-identical**; ENOENT (the normal no-consent state) never counts; the signal is try-wrapped so it cannot alter a gate outcome under any circumstances | write signal removed → only the counter half of its paired test fails, the fail-closed half stays green → restored. All five existing consent suites re-run green on the edited file. |
| A3 | (this commit) | `feature.opened` per section open, allowlisted in MAIN (a renderer cannot invent vocabulary); junk/prose/invented ids dropped; one `useEffect` at the navigation convergence point | allowlist test: 6 junk shapes rejected, 2 real ids recorded, exact-list |

**Deferred, flagged:** the `retrieval.query` wiring line in `memory/rag.ts`
(M28-shared file — coordinated through the founder, added after the M28
merge). The helper, its tests, and the SQL-side view treat the signal as
first-class already.

## Claim audit — A5 as built (2026-08-24)

Founder's directive: "The Export button and BUG-088's upload fix should
provably share one mechanism" and "red-check [BUG-090] against the actual
failure shape, not a constructed one."

| Step | Commit | Claim | Red-check |
|---|---|---|---|
| A5.1 / BUG-090 | `176a1e5` | A permanent 4xx (400) is dropped and acked so the queue keeps moving, never retried, never counted as "sent"; 5xx and network failures still retry on the existing backoff ladder | Test built against the failure's real shape: a server that rejects the FIRST batch with a real 400 then behaves normally, vs. one that returns 503. The 400 case: batch acked, queue drains, next batch proceeds. The 503 case: batch stays queued, backoff scheduled, nothing acked. |
| A5.2 / BUG-088 + BUG-089 | `d2038db` | One mechanism, `snapshotMemoryDb()` — live handle when running, else an online `db.backup()` open readonly without the vector extension — used by BOTH the cloud upload and (A5.3) the Export button; restore clears stale `-wal`/`-shm` sidecars before writing | Fixture reproduces BUG-088's exact live shape (a checkpointed row + a WAL-only row); CONTROL proves a raw `fs.readFile` loses the WAL-only row; the fix's own test proves it doesn't. BUG-089: stale sidecars planted with no main file present, restore proven to clear them and produce a readable DB. Structural assertion (comments stripped first): `backup.ts`'s upload function contains `snapshotMemoryDb(`, not `readFile(dbPath)`. |
| A5.3 | `03b70f7` | "Export Sales Brain…" writes a consistent snapshot to a founder-chosen path while the app keeps running, via the same shared mechanism | Real WAL fixture, both rows present in the exported file; cancel exports nothing; no-Sales-Brain-yet returns an honest reason, never throws. Extended structural assertion: `export-ipc.ts` contains `snapshotMemoryDb(`, never `better-sqlite3` or `.backup(` directly — the one-mechanism constraint checked from BOTH callers, not just the upload side. |
| A5.4 | `5a25072` | One-click support bundle: fallback log, purpose health, job history, versions, device basics — closed filename allowlist, pinned by test; free-text fields (fallback `detail`, `lastFailureDetail`, job `title`/`resultData`) stripped, not merely scrubbed; everything else passes the A1.0 scrubber; never memory.db, keys, or app-settings.json | Every source poisoned, control proves the poison is really in the source first. Detail-strip line removed on purpose → the poisoned provider-error string shows up verbatim in the bundle → red for the right reason (not a syntax error) → restored → 11/11. Reused `tier1-diagnostics.ts`'s `engineDiagnosticFiles()` for the kern_bridge log paths after a first-pass hand-rolled version put `kern_bridge_status.json` under the wrong subdirectory — caught by cross-checking against the M27 code that already had it right, not by a failing test. |

**Corrected before it shipped, not caught by a test:** A5.4's first draft
hand-derived the kern_bridge log paths instead of reusing M27's
`engineDiagnosticFiles()`, and got one of the three wrong
(`kern_bridge_status.json` lives directly under `%LOCALAPPDATA%\CallRiseAI\`,
not `...\logs\`). Found by reading the existing module before trusting a
freshly-written path-building function — the grep-first rule in
`CLAUDE.md`, applied to code instead of an identifier rename.

**Full suite after A5:** 230/230 test files, 2261 passed / 9 skipped, exit 0.
`typecheck:node` and `typecheck:web` both clean.

## Claim audit — B2 entitlements scaffold as built (2026-08-24)

Built while the cutover and clean-machine walk wait on the founder — the
CONSUMPTION side only, inert behind a local enforcement constant (`false`),
so nothing user-facing changed. Memo: `docs/M29-B2-entitlements-memo.md`.

| Piece | Commit | Claim | Red-check |
|---|---|---|---|
| token.ts | `240de18` | Verify, never mint: the client holds only the Ed25519 PUBLIC key, so it can verify a Pro entitlement but not forge one; a bad signature, a tampered claim, a wrong-user replay, and a missing key each fail (never a pass) | Signature check forced to pass → the tamper test and the different-keypair test both go red (`ok:true` leaks a plan through) → restored → 7/7. Tested against a real generated test keypair, not a stub. |
| store.ts | `240de18` | Encrypted-at-rest cache (safeStorage, refuses to write plaintext if encryption is unavailable); offline grace = 14 days past period end; perpetual (null end) in force unless explicitly canceled; `none`/`canceled` never in force | Boundary tests at exactly grace edge (inclusive), one ms past, perpetual, canceled-perpetual, status-none. The on-disk file asserted to not contain the token string. |
| decide.ts | `240de18` | Enforcement OFF (beta) = always true, nothing else consulted; ON = in-force entitlement whose plan grants the feature; the production `PLAN_GRANTS` is empty so no feature is paid yet | Full matrix incl. "in-force pro grants nothing under the empty production map" — proves the gate consults the feature map, not merely "has a plan." |
| index.ts | `240de18` | `isEntitled` is the ONE gate; `ENTITLEMENTS_ENFORCED` is a LOCAL constant, never a remote flag; the module never imports the flags module | Structural test: a `../flags` import injected into the module → isolation test goes red → restored. Beta-posture test: `isEntitled` returns true and never calls the token store while enforcement is off. |

**Full suite after B2:** 234/234 test files, 2289 passed / 9 skipped, exit 0;
`typecheck:node` clean. Provisioning SQL `supabase/2026-08-entitlements.sql`
added to the day-one checklist (cutover runbook + migration memo).
