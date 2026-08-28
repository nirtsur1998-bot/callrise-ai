# M29 A2 — the health-signal set, mapped to the incidents it exists to catch

**The brief's test for every signal:** "would this have caught BUG-080 / the
Sales Brain native-module failure / the 1.3.0 empty-UI gap within days?"
Answered per signal below, honestly, including the one that only partly
would. All signals are aggregate counters/enums through `record()` —
consent-gated, token-validated (no whitespace → no prose → no content),
scrubbed, bounded. The catalog is closed: `src/main/telemetry/signals.ts`
is the only place an event name can exist.

| Signal | Emitted from | Catches (real incident) | Within days? |
|---|---|---|---|
| `native.load` {module, ok, errorClass} — once per module per process | `memory/db.ts` (better-sqlite3, sqlite-vec), `detection/adapters/{Windows,Mac}Adapter.ts` (win-audio-sessions, mac-audio-activity) | **Sales Brain dead on clean Windows** (`be512bc`): loads on every dev box and CI runner, ERR_MOD_NOT_FOUND on real installs | **Yes — minutes.** The first opted-in stranger's first launch emits `ok:false`. |
| `retrieval.query` {resultCount, zero} | helper ready; **wiring deferred** — the one-line call belongs in `memory/rag.ts`, an M28-shared file (M28 rebuilt retrieval); added after the M28 merge, per the shared-file rule | **BUG-080**: question-scoped retrieval returned nothing for every natural question for ~9 days | **Yes, once wired** — a 100 % zero-rate across installs with memories is unambiguous; caveat: needs users actually asking (the surface must be used). |
| `tier1.state` {engineAvailable, engineRunning, denoising} — change-only | `tier1.ts` broadcast() | **The 1.3.0 gap**, both halves it can see: `engineAvailable:false` for every Windows install = the missing extraResources block; `engineRunning:true, denoising:'false'` = the df_create silent passthrough | **Partly.** The state jump (0 %→100 % running between versions) and the passthrough are visible in days. The *missing settings UI* is not a telemetry-visible fact — that catch belongs to the release checklist + What's New (B5), and the doc says so rather than pretending. |
| `ai.purpose.failed` {purpose, failureClass, code, providerId} + `ai.purpose.recovered` {purpose, afterConsecutiveFailures} | `ai/purpose-health-store.ts` (the aggregation point — NOT the fallback chain, which stays untouched) | **BUG-081/082 class** (dead default model on a provider; a too-thin fallback tail live-blocking Rise) and **BUG-058**'s free-tier spirals | **Yes** — "every install with a Groq key fails `model-not-found` on purpose X since vX" is a first-day query. |
| `job.finished` {jobType, outcome, code} — every terminal transition incl. silent jobs | `jobs/JobManager.ts` transition() (the one funnel; the Activity notifier skips silent jobs) | The **Sales-Brain-import / background-work failure class** (BUG-072: import could never finish on a rate-limited key) | **Yes** — failure-rate per jobType per version. |
| `update.outcome` {outcome, code} | `updater/index.ts` (available / refused-classified / downloaded / install-requested / error-class) | A field-broken updater — the class where a fix exists but never reaches anyone (this milestone's whole premise) | **Yes** — downloads-vs-installs per version, refusals visible at all (today they reach a console nobody sees). |
| `backup.stepFailed` {step, code} | `backup.ts` reportBackupStep at all 18 best-effort sites | **BUG-087**: the sales-brain bucket never existed, so every memory.db upload failed silently since M25 | **Yes — first sync.** `{step: salesBrainUpload, code: NoSuchBucket}` from 100 % of installs is exactly the dashboard row that was missing for eleven weeks. |
| `consent.flowError` {op, code} | `consent-gate.ts` catch sites (write/read/clear) — **the last, most careful edit; additive one-liners inside existing catches** | The invisible-fail-closed class from the audit (§1.5): a consent write failing means a user is silently denied a capability they said yes to | **Yes** for systemic causes (disk/profile problems across installs). |
| `crash.*` + `session.start/end` (A1.2/A1.3) | log.ts, index.ts, setup.ts | The **1.1.x portable-never-launches class** and anything that kills the process | **Yes** — crash-free rate per version is the `telemetry_version_health` view. |

**What A2 deliberately does not emit:** provider error text (`detail` —
red-checked: wiring it in makes the event vanish rather than ship prose),
job titles or `resultData`, error messages, verdict prose (classified into
codes), the enabled *pref* for Tier 1 (renderer-local; `engineRunning`
already carries the fact), anything with whitespace.
