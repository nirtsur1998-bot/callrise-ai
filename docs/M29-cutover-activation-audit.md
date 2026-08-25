# Cutover activation audit — code that has NEVER run in production, and goes live the day the backend exists

**Why this document exists (founder, 2026-08-24, naming taxonomy species 24
— "the bug that only activates when you fix the other one"):** BUG-088
(WAL-blind uploads) was invisible for eleven weeks because BUG-087 (no
bucket) meant no upload ever succeeded. Same shape as the never-exercised
paths downstream of BUG-080's zero results. **Rule: when fixing something
that has been failing completely, audit what was never exercised downstream
of it — code past the failure has never been tested by reality, only by
tests that constructed the state directly.** Applied here, deliberately,
before the Supabase cutover instead of as three incidents after it.

Every row below is code that exists in the shipped app (or the M29 branch)
and has **never executed in production**, with what happens the first time
it does. Findings marked ● are new bugs found BY this audit.

---

## Goes live at CUTOVER (the new project's day-one provisioning)

### 1. The `sales-brain` bucket exists → the whole memory.db cloud path runs

| Path | First real execution | Verdict |
|---|---|---|
| `uploadSalesBrainDb` success path (`backup.ts:470-483`) | Uploads on the first sync | **BUG-088** (already logged): reads only `memory.db`, WAL-blind — on this machine it would have uploaded an Aug 14 file on Aug 24. Fix (db.backup() snapshot) MUST ride the cutover release. |
| ● `downloadSalesBrainDb` restore path (`backup.ts:485-513`) | A fresh install with a cloud copy writes `memory.db` | **NEW — BUG-089:** it writes the restored file **without clearing stale `-wal`/`-shm` sidecars**. `removeWalSidecars` (db.ts) exists precisely because "leaving a stale -wal/-shm next to a just-restored memory.db risks SQLite reading inconsistent state" — but only the schema-migration restore path calls it (db.ts:254); the cloud-download path, dormant since M25, never does. Rare trigger (sidecars without a main file), catastrophic shape (silently wrong memories). One-line fix, same release. |
| Memory runtime opening a downloaded db | Migration-on-open runs against a file made by another machine's app version | Covered by design (migrations are versioned, `pre-migration-backup` taken) — but reality-untested across versions; note for the cutover verify step. |

### 2. `server_now()` + `clock_skew_repaired` exist → the M21 skew machinery runs

| Path | First real execution | Verdict |
|---|---|---|
| Skew measurement (`backup.ts:342,780-790`) → `clockSkewMs` persisted | First sync measures real skew | 25 references of correction machinery (`toServerMs/toServerIso/toDeviceIso`, normalised uploads, reconcile re-stamping) — the most heavily red-checked code in the repo (M21 Phases B/F, six revert-verified regressions) but **zero production executions ever**. No new defect found by inspection; the risk is inherently reality-shaped (real clocks, real latency). Cutover verify: sync on this machine, confirm `clockSkewMs` is a small number, spot-check one record's timestamps. |
| The >2 min clock warning UI | Shows only for a genuinely skewed machine | Never rendered in production; harmless if wrong (non-blocking). |
| The repair migration (`backup-schema.sql:432-471`) | Runs on the NEW project's **empty** tables | No-op by construction (nothing to repair). The dormant hazard it guarded — repairing rows with the trigger live — cannot occur on empty tables. |

### 3. The `telemetry_events` table exists → the transport success path runs

| Path | First real execution | Verdict |
|---|---|---|
| `sendBatch` 2xx → ack → sent-log (`flush.ts:96-106`) | First "Send now" / scheduled flush | Tested against a mocked fetch only; never against real PostgREST. Client validation and the server trigger were written to mirror each other (token/stack/name/props rules re-checked side-by-side for this audit — aligned) but PostgRESTs's own 400 shapes are reality-only. |
| ● Failure handling (`flush.ts:108-111`) | First server **rejection** | **NEW — BUG-090 (M29 branch, unshipped):** every failure backs off and retries — a permanent 400 (a batch the server will never accept) is treated like a transient 503, and because batches are head-of-queue, one poisoned batch blocks ALL telemetry, retrying forever until 500 newer events evict it. Fix before the cutover release: on 4xx, drop (ack) the batch — losing telemetry beats a stuck pipeline; keep backoff-retry for 5xx/network only. |
| `telemetry_version_health` view, `telemetry_prune()` | First rows / first scheduled prune | View is read-only SQL (verify with the first real rows); the prune needs its pg_cron schedule created on the new project — **add to the day-one provisioning checklist** or it silently never runs (species 23 again). |

### 4. Related activation, different cause — first MASS execution at 1.3.4

Auto-update's background loop (6 h check → auto-download → install-on-quit)
has only ever run on machines where the toggle was manually flipped —
effectively one. The 1.3.4 default flip is its first run across every
install at once. Not backend-dormant, but the same species-24 shape; the
staged rollout (10 % default) is the containment, which is why the founder's
CI-first ordering mattered.

---

## Goes live at the ALERTS DEPLOY (later, deliberately NOT at cutover)

The entire alerts server side has zero production executions: every IPC
success path (channel create/verify/confirm, rules CRUD, settings,
deliveries list), the Telegram deep-link + webhook nonce burn, the email
double-opt-in, the cron→dispatcher→adapter delivery chain, quiet-hours and
rate-limit behaviour, and the Realtime desktop-delivery subscription. This
is exactly why the alerts memo requires an end-to-end alert **received on a
second machine** before the section un-hides, and why `alerts-schema.sql`
is excluded from the cutover's day-one paste list — activating one
never-run surface at a time, on purpose.

---

## Actions (all pre-cutover, riding the already-planned releases)

| # | Item | Rides with |
|---|---|---|
| 1 | BUG-088: snapshot-based upload (db.backup()) | cutover release (already in the migration memo, step 4) |
| 2 | ● BUG-089: `removeWalSidecars` in `downloadSalesBrainDb` | same commit as BUG-088 — same file, same subsystem |
| 3 | ● BUG-090: 4xx drops the batch; only 5xx/network retries | A5 batch (telemetry code, M29 branch, unshipped — fix before it ever meets a real server) |
| 4 | pg_cron schedule for `telemetry_prune()` added to the provisioning checklist | migration memo step 2 |
| 5 | Cutover verify step extended: skew number sane, memory.db in the bucket with a **fresh** mtime, telemetry row landed, and a **deliberate RESTORE test on a second profile/VM with stale sidecars planted** (BUG-089 lives in restore; upload-only verification would leave it exactly as unexercised as this audit found it) | migration memo step 6 + `M29-cutover-runbook.md` RAMP gate |
