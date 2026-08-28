# Supabase cutover runbook — with a rollback, not just a checklist

**Who this is for:** the founder, executing the migration decided in
`M29-supabase-migration-memo.md` (fresh start). Every step is explicit;
every failure has a stated path back. **Date:** 2026-08-24.

**The fact that makes rollback tractable:** the cutover is a **client
release, not a server flip.** Nothing happens to the old project; "cutover"
means shipping a build whose `default-config.ts` points at the new one.
Each install talks to exactly one project — whichever its build embeds — so
there is no half-written server state anywhere, ever. Two consequences:

1. **Rollback = roll FORWARD** to a patch version pointing back at the old
   project (`allowDowngrade=false` is deliberate; you never downgrade, you
   ship the next number with the old config).
2. **The old project's 30-day parachute IS the rollback path**, not a
   courtesy. The old project must stay alive until the cutover build is at
   100 % and stable — delete it and there is nothing to roll back to.

---

## GO gate (all true before the tag)

> ### ⛔ THE SALES BRAIN GATE IS CURRENTLY UNPASSABLE BY CONSTRUCTION
>
> **Do not attempt the Sales Brain steps of the RAMP gate until BUG-091 ships.**
>
> `syncScope.salesBrain` has **no writer anywhere in the renderer** — the Backup
> card hand-writes a five-key union where main declares six, and it is the only
> place `syncScope` is ever set. The flag defaults `false` and nothing in the
> product can turn it on. Both `uploadSalesBrainDb` and `downloadSalesBrainDb`
> are gated on it (`backup.ts:681` and `:962`).
>
> So the check below — *"`sales-brain/<uid>/memory.db` exists with a timestamp
> from the last few minutes"* — **cannot pass**, and cannot be made to pass by
> testing harder. The object will never appear, because nothing uploads it.
> Confirmed on the founder's own install: `"salesBrain": false` in `syncScope`
> while Sales Brain itself is enabled.
>
> This matters beyond the gate: it is why BUG-087 ("the upload fails into a
> swallowed console.error") is wrong — the upload never *ran* — and why
> BUG-088 and BUG-089 were reopened as unverified. Creating the bucket at
> cutover is **necessary but not sufficient**; without BUG-091 the bucket stays
> empty forever.
>
> The failure mode this box exists to prevent: reaching the gate, seeing no
> object, and concluding the *bucket* or the *provisioning* is broken — then
> re-running SQL and re-probing the server while the actual cause sits in a
> renderer type declaration. Taxonomy **species 25**.
>
> **Order: fix BUG-091 (+BUG-092, same commit) → ship → then the gate means
> something again.**

- [ ] Real user count read in old project → Authentication → Users, and the
  fresh-start decision confirmed against it (memo decision 1).
- [ ] **BUG-091 FIXED AND SHIPPED FIRST.** This is a hard blocker, not a
  preference — see the box at the top of this gate. Until it lands, the
  Sales Brain half of the RAMP gate cannot be satisfied by any amount of
  testing.
- [ ] A5 landed; **BUG-092 fixed in the same commit as BUG-091** (an empty
  local memory.db must not defeat the restore guard and overwrite the cloud
  copy — shipping the toggle without this guard makes disaster recovery
  actively worse than not having it).
- [ ] **BUG-088 + BUG-089 fixes merged AND then actually executed once.**
  Their code is on the branch and red-checked, but both were reopened as
  **UNVERIFIED** on 2026-08-24: they live inside functions the product could
  not call, so neither has ever run. "Merged" is not the bar here; "observed
  working" is, and the RAMP gate below is where that happens.
- [ ] **BUG-090's correction merged** (drop only 400/409/413/422; 404, 429,
  408, 401/403 and anything unrecognised must RETRY). The first version of
  that fix dropped the whole 4xx range, and **404 is the day-one condition**
  — the telemetry table does not exist until the SQL below is run, so the
  original fix would have silently deleted the cutover week's telemetry.
- [ ] New project created; **all five SQL files** run in order
  (`backup-schema` → `2026-07-deals-and-scrub` → `2026-08-sales-brain-backup`
  → `2026-08-telemetry` → `2026-08-entitlements`), **plus** the pg_cron
  schedule for `telemetry_prune()`. NOT `alerts-schema.sql` (stays for the
  alerts deploy). `2026-08-entitlements.sql` provisions the read-but-never-
  write entitlements table now so B2 needs no schema step later — but the
  entitlement *token* is still inert until billing ships (B4), so this file
  is safe to run day one and grants nobody anything.
- [ ] **Probe verification passed** (session runs it, read-only, anon key):
  8 backup tables → 200; `server_now()` returns a timestamp;
  `clock_skew_repaired` selects; `attachments` and `sales-brain` buckets
  answer "Object not found" (exists), never "Bucket not found"; telemetry
  insert of a valid row → 201 and of a malformed row → 4xx;
  `schema_versions` holds a row per file. Species 23: provisioned is a
  probe result, not a memory.
- [ ] Fresh manual Sales Brain backup taken (stopgap doc — all three files,
  app quit).
- [ ] The clean VM / second profile is available for the restore test below.

## Ship

1. One release (say 1.5.0): new `SUPABASE_URL` + `SUPABASE_ANON_KEY` in
   `default-config.ts`, the one-time cutover notice card ("create your
   account again with the same email — your data is on your machine and is
   not affected; don't press Sign out"), full suite green.
2. Tag. It ships **staged at 10 %** like everything now. Because the notice
   is the whole point and the population is tiny, ramping quickly is fine —
   but hold at 10 % until the RAMP gate below passes.

## RAMP gate (on your own machine, on the cutover build)

- [ ] Update → sign-in screen appears → **keys and local data intact**
  (Settings → API keys still populated; calls/tasks present).
- [ ] Create account (same email) → code → in.
- [ ] **Turn ON Settings → Cloud backup → "Sales Brain memories".** This
  toggle does not exist until BUG-091 ships — if you cannot find it, STOP:
  the rest of this step is unpassable, not failing. (See the blocker box in
  the GO gate.)
- [ ] Sync now → old-project audit repeated against the NEW project's
  dashboard: backup rows present; **`sales-brain/<uid>/memory.db` exists
  with a timestamp from the last few minutes** (BUG-088's fix proven by
  freshness, not presence — and this is the **first ever real execution** of
  that upload path, so treat a failure here as a live bug, not a
  misconfiguration); `clockSkewMs` in `backup-state.json` is a small number
  (the M21 machinery's first reality test).
- [ ] Diagnostics & telemetry → Send now → a row in `telemetry_events`, and
  `telemetry_version_health` shows the session.
- [ ] **THE RESTORE TEST (founder's addition — BUG-089 lives here, and a
  cutover that only verifies uploads leaves the restore path exactly as
  unexercised as the audit found it):** on the clean VM / second Windows
  profile: install the cutover build → sign in with the same account →
  first sync pulls the cloud memory.db → Memory Center shows the memories.
  Plant stale sidecars first (create empty `memory.db-wal`/`-shm` in
  `%APPDATA%\sales-os` before first launch) so the BUG-089 fix is exercised
  against its actual trigger, not just present in the diff. This is also the
  **first ever real execution** of `downloadSalesBrainDb`.
- [ ] **THE EMPTY-HUSK TEST (BUG-092's actual trigger).** On the same clean
  VM, in a second run: enable Sales Brain FIRST (which creates an empty
  `memory.db`), *then* turn the backup toggle on, then sync. The cloud copy
  must still be intact afterwards. Before BUG-092's fix this sequence
  destroys it — the restore is skipped because a file exists, and the empty
  database is then uploaded over the only backup with `upsert: true`. Verify
  by checking the object's size/timestamp did NOT regress.
- [ ] Then ramp per the rollout runbook §2 (50 → 100).

## What "partially cut over" looks like (normal, by design) and how to read it

During the ramp the population is split: installs on old builds sync to the
OLD project; installs on the cutover build sync to the NEW one. Nobody loses
anything — local-first. **Detection of who is where:**

- New project: `telemetry_version_health` (cutover-build installs, opted-in)
  and Authentication → Users (re-registrations).
- Old project: `select max(server_updated_at) from backup_calls;` (repeat
  per table) — recent timestamps = installs still syncing there.

**The DELETE gate for the old project:** zero old-project sync activity for
30 consecutive days (the query above), AND the cutover build at 100 %, AND
the founder confirms. Calendar reminder, not memory.

## Failure modes and the stated path back

| # | What went wrong | How you notice | The path back |
|---|---|---|---|
| 1 | New project misconfigured / URL or key typo'd in the build | New-version installs can't sign up; no rows appear; the RAMP gate fails on your own machine | **Halt** (`stagingPercentage: 0`, rollout runbook §2.6). If it's provisioning: fix, re-probe, resume the ramp. If it's the build: **roll forward** — next patch version with the corrected (or old) config, ship at 100 % (its audience is exactly the affected cohort). |
| 2 | A species-24 activation bug appears in the un-shielded paths despite the audit | Telemetry from cutover installs (this is why BUG-090's fix precedes cutover — the eyes must work during the week you need them), or your own RAMP-gate testing | Halt; assess with the activation audit as the map; fix; next patch version. The old project is untouched throughout. |
| 3 | Something is wrong enough to abandon the attempt | Any of the above, unfixable quickly | **Roll forward to old config:** next version, `default-config.ts` back to the old URL/key, ship at 100 %. Users who already re-registered bounce through one more sign-in (their OLD account still exists — the parachute); local data untouched again. The new project keeps whatever it received; re-attempt later re-syncs from local truth, so nothing is stranded. |
| 4 | Supabase outage on the new project mid-ramp | Sync errors everywhere at once, status.supabase.com agrees | Not a cutover failure. Do nothing — every cloud path is best-effort by design; local work is unaffected; syncs resume. |
| 5 | Users confused at re-registration ("my account is gone") | Support pings | The notice card is the mitigation; reply macro: "Your data is on your machine and untouched. We moved our sign-in service — create your account again with the same email and everything re-uploads itself. Don't press Sign out (it clears your saved API keys)." |

**One rule under pressure (the founder's own, species 23):** if anything
tempts an incremental server-side patch mid-cutover — "just add the missing
bit to the new project by hand" — it goes through the SQL files + re-probe,
never through a dashboard one-off. The provisioning stays reproducible or
the migration stops being the cure.
