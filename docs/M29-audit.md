# M29 Phase 0 — Map & audit

**Date:** 2026-08-23. **Worktree:** `C:\Users\User\Desktop\callrise-m29`,
branch `claude/m29-eyes-and-engine` off `main` @ `14969ab` (v1.3.2).
**Method:** four parallel read-only code audits (error handling, Supabase,
first-run, plus the pricing research in `M29-pricing-memo.md`), with the
highest-stakes claims re-verified first-hand: the staged-rollout mechanism
was read in the installed `electron-updater`, and the live Supabase project
was probed with the public anon key to separate "in the repo" from
"actually deployed." Nothing was edited, installed, or published.

**Companion documents written in this phase:**
- `docs/M29-rollout-runbook.md` — exact steps to ship at N% and ramp (works today, no code).
- `docs/M29-remote-flags-memo.md` — kill-switch decision memo.
- `docs/M29-pricing-memo.md` — B1 decision memo with the full evidence report.

---

## 0. The ten things the founder should know (plain language)

1. **Staged rollout already works — zero app code needed.** Our installed
   `electron-updater` (6.8.9) honours a `stagingPercentage` line in
   `latest.yml`; every install already has its cohort UUID on disk
   (`%APPDATA%\sales-os\.updaterId` — this machine has one). The runbook has
   copy-paste commands. A three-line CI change makes it zero-window.
2. **Auto-update is OFF by default.** Nobody gets a fix unless they open
   Settings → App and click "Check for updates" (or have opted in). This
   quietly undercuts every release-safety mechanism: you can halt a bad
   version, but you can't *push* the good one. (Decision needed — see §3.)
3. **The install base is tiny.** `latest.yml` for v1.3.2 has 18 downloads in
   five days (each manual check fetches it once); the installer has 1. Some
   of those are this machine. Percentages of ~5 installs are 0 or 1 people.
   Build the eyes anyway — they are for the next 500 users — but don't expect
   a 10% cohort to tell you anything yet.
4. **Nothing in the app is telemetry today, and nothing leaves the machine
   except what the user sets up** (Supabase auth/backup, their own AI keys,
   calendar OAuth) — plus one thing the brand copy should know about: the
   updater sends the `.updaterId` UUID to GitHub as a header on every update
   check. Not ours, not tied to the account, but not "nothing."
5. **The logs are real but siloed and unreadable by machines.** Eight
   on-disk artifacts, two crash handlers writing the same event to two files,
   55 `console.error` calls in the main process that go nowhere in a packaged
   app, and 70% of `catch` blocks that swallow silently. The good news: the
   three *structured* ones (`ai-fallback-events.jsonl`,
   `ai-purpose-health.json`, `jobs-state.json`) are exactly the shape A2
   needs.
6. **There is no scrubbing anywhere.** Every stack trace and every path field
   carries `C:\Users\<name>\…`. The Windows username is the universal leak
   in every existing log. A1's scrubber is load-bearing, not polish.
7. **Supabase: what's in the repo ≠ what's deployed.** Live project has Auth
   + the 8 `backup_*` tables. **Not deployed:** the `server_now()` RPC (so the
   M21 clock-skew fix has been silently inert since it shipped), all five
   alerts tables, and all four edge functions. Consequence: **Settings →
   Alerts → "Scheduled alerts" is visible to every user and fails at step one
   (`create-failed`)** — a dead feature shipped since M19. A telemetry ingest
   would be this project's first edge-function deploy and first `anon` grant.
8. **There is zero entitlement plumbing.** No subscription/plan/trial/license
   code, no per-user row beyond `auth.users`, no roles or claims, no
   `profiles` table. B2 starts from a blank page — which is fine, it's a
   small page.
9. **The first run is rough, as predicted** — 13 ranked rough edges in §4.
   The top three: an unsigned 350 MB installer behind a SmartScreen wall; a
   mandatory account + email code before any value; and then zero value until
   the stranger goes and gets a Deepgram key themselves, with copy that
   contradicts itself about whether they must restart.
10. **Three hotfix branches are still unmerged into `main`**, including
    BUG-080 (Sales Brain retrieval returns nothing) — so v1.3.2 ships it.
    Listed in §7 for your decision; not touched by this session.

---

## 1. Error handling today — what exists, what's siloed

### 1.1 Crash capture

| Layer | Handler | Writes to | After |
|---|---|---|---|
| Main, pre-import | `process.on('uncaughtException'/'unhandledRejection')` — `src/main/index.ts:9-25` | `%TEMP%\callrise-startup-crash.log`, plain text, **no cap**, plus 5 breadcrumb lines on every launch | continues |
| Main, post-userData | same two events again — `src/main/log.ts:58-63` | `%APPDATA%\sales-os\logs\callrise.log`, text, 2 MB ×2 rotation | continues; suppresses Electron's dialog (`transcription.ts:316-317`) |
| Renderer gone | `webContents.on('render-process-gone')` — `index.ts:299-302` | `console.error` only (lost in packaged app) + `disposeTranscription(); endLiveCallUnsaved()` | **window left dead; no reload, no dialog, nothing on disk** |
| Renderer JS | `window.onerror` / `unhandledrejection` — `renderer/src/main.tsx:9-16`; `ErrorBoundary.tsx:21-49` | forwarded over `app:logRendererError` IPC into `callrise.log` | boundary shows "Something went wrong … Reload" |
| Does not exist | `child-process-gone`, `crashReporter.start` (native minidumps), any log-level IPC rate limit | — | — |

`logError`/`logInfo` have **zero callers** outside `log.ts`. The main process
has 55 `console.error`, 5 `console.warn`, 26 `console.log` that reach stdout
only — which in a GUI-launched packaged Windows app is nowhere
(`index.ts:2-8` describes this loss in its own words).

### 1.2 The structured records (what A2 builds on)

**`ai-fallback-events.jsonl`** (`src/main/ai/fallback-log.ts:18-29`), 1000-line
cap, failures only, emitted from `complete-with-fallback.ts:461,819,1117`:

```ts
{ ts, purpose: AIPurpose, fromCatalogId, toCatalogId: string|null /* null = chain exhausted */,
  reason: string /* error code | 'failed' | 'timeout' | 'skipped: …' */, detail?: string /* provider's raw error text */ }
```

**`ai-purpose-health.json`** (`purpose-health.ts:65-97`), one record per
purpose (12): `consecutiveFailures, failureEpisodes, first/lastFailureAt,
lastFailureReason, lastFailureProviderId, lastFailureDetail,
lastFailureClass ('transient'|'period-exhausted'|'structural'),
lastFailureResetsAt, lastSuccessAt, lastSuccessProviderId, substitutingSince,
substituteSuccesses, substituteProviderId`. Derived severity
(`ok | not-configured | substituting | failing`) is exposed over
`purposeHealth:getAll` and read by exactly one screen
(`ModelAssignmentSection.tsx:330-345`, polling 60 s). **The BUG-057 design's
Home banner and Memory Center empty-state were never built.**

**`jobs-state.json`** (`jobs/types.ts:8-97`): `JobState = queued|running|
succeeded|failed|cancelled|interrupted`, `error?: { message, code? }`, cap 500
by count (`retention.ts:23`). Persist failure → `console.error` only
(`JobManager.ts:41-46`). **`resultData` is persisted verbatim** — full CRM
note text, KYC facts, proposed task titles/client names, detected contact
names. Local-only today; must never be mirrored into telemetry.

### 1.3 The M27/Tier 1 diagnostics

- `--diagnose` (`src/main/diagnose.ts`): stdout only, never a file, not in the
  zip. Prints absolute paths (username), active consent `callId`, key
  *presence* (names, never values — the one deliberate redaction).
- "Export diagnostics" zip (`src/main/tier1-diagnostics.ts`, commit
  `7da1342`): **engine-only** — `kern_bridge.log` / its rotated `.log.1` / `kern_bridge_status.json` (this line said `.prev.log` until 2026-08-24 — a name the engine never writes; see BUG-091's sibling finding in `M29-sweep-findings.md` S2) +
  `app-diagnostics.json` (version, platform, Tier 1 state, strength, mic
  labels). Privacy pinned by `tier1-diagnostics.test.ts:85-127` (exact path
  list). **Not in it:** `callrise.log`, `session-health.log`,
  `ai-fallback-events.jsonl`, `ai-purpose-health.json`, `jobs-state.json`,
  the startup crash log. "Open log file" (Settings → App) and the zip are two
  disconnected support paths. M27 itself shipped no support bundle
  (`M27-audit-findings.md:94`, item I1 flagged open).

### 1.4 Every on-disk artifact, and what in it must never leave the machine

| # | Path | Structured | Who reads it | Content that must be scrubbed or excluded |
|---|---|---|---|---|
| 1 | `%TEMP%\callrise-startup-crash.log` | no | nobody | stacks → **username in paths** |
| 2 | `%APPDATA%\sales-os\logs\callrise.log` (+`.old`) | no | user via button | stacks → **username**; renderer rejection text may carry provider error strings |
| 3 | `…\session-health.log` | k=v | nobody | session/producer ids only — safe |
| 4 | `…\ai-fallback-events.jsonl` | **yes** | Settings (last 20) | `detail` = raw provider error text (≤300 chars OpenAI-compat; **unbounded** Gemini) — can echo request fragments |
| 5 | `…\ai-purpose-health.json` | **yes** | Settings (derived) | `lastFailureDetail` (same); provider id reveals which vendor keys exist |
| 6 | `…\jobs-state.json` | **yes** | Activity Center, Job Inspector | **`resultData` = user/customer content**; `error.message` raw |
| 7 | `…\backup-state.json` | yes | BackupCard | raw Supabase error strings (may contain user id, bucket paths) |
| 8 | `%LOCALAPPDATA%\CallRiseAI\logs\kern_bridge*.log`, `_status.json` | partly | zip | log/model paths → **username**; mic device name |

Nothing contains transcript text, memories, or key values. **The universal
leak is the Windows username via absolute paths.** There is no
redact/scrub/sanitize for logs anywhere in `src/` (the only scrubbers are
data-layer: `makeFreeTextScrubber` for AI reports, journal consent redaction,
`maskedHint()` for key display).

### 1.5 Where errors are thrown away

237 of 337 `catch` blocks in `src/main` (70%) swallow silently (empty body or
bare return); 69 of 129 in the renderer. Many are legitimate
"file absent → default." Ones that are not, by area:

| Area | Site | What's lost |
|---|---|---|
| AI purpose | `memory/memory-hooks.ts:134` | `aiFailed`/`failureReason` that `extraction.ts:222-230` was changed to return — the per-call job *succeeds* with 0 memories |
| AI purpose | `live-cue.ts:96-98` | the error object, entirely |
| AI purpose / IPC | `coaching-chat-ipc.ts:328-332` (+6 siblings) | returns "Something went wrong," logs nothing |
| Backup | `backup.ts:504-513`, `:441-455`, `:316-320` | memory.db / attachment download failures; even the state file write that records errors can fail silently |
| Consent | `consent-gate.ts:81-89`, `:105-107` | *why* a consent write failed (fail-closed, correctly, but invisibly); read failure indistinguishable from "no grant" |
| Auth | `auth.ts:94-98` | session-token write failure → user silently logged out on next launch |
| Updater | `updater/index.ts:67-68,146,229-247,281-285`, `policy.ts:66` | every update failure goes to `console.*` only — **no update failure ever reaches disk** |
| Privacy | `live/call-journal.ts:511-515` | journal redaction failure → `console.error` only |

The A2 "update success/failure" and "consent-flow errors" signals therefore
have **no existing source** to promote — those counters must be added at the
sites above.

---

## 2. Supabase — declared vs deployed

### 2.1 What's actually on the live project (probed 2026-08-23 with the public anon key)

| Object | In repo | Live | Evidence |
|---|---|---|---|
| Auth (GoTrue v2.195.0) | — | ✅ | `/auth/v1/health` 200 |
| `backup_tasks/events/calls/knowledge/contacts/deals/deal_stages/settings` | `backup-schema.sql` | ✅ all 8 | anon `select` → 200 (RLS returns empty) |
| `server_now()` RPC | `backup-schema.sql:24-31` | ❌ | `PGRST202 could not find function` → **M21 clock-skew correction has been inert in every shipped build**; app falls back safely (`backup.ts:330-335`) |
| `notification_channels`, `alert_rules`, `alert_rule_channels`, `alert_deliveries`, `user_alert_settings` | `alerts-schema.sql` | ❌ all 5 | 404 |
| Edge functions `alert-dispatcher`, `send-verification-email`, `send-test-alert-email`, `telegram-webhook` | `supabase/functions/` | ❌ all 4 | `{"code":"NOT_FOUND","message":"Requested function was not found"}` |
| Storage buckets `attachments`, `sales-brain` | two SQL files | could not verify anonymously (bucket listing needs auth) | — |

**Consequence (user-visible):** Settings → Alerts → "Scheduled alerts"
(`settings-nav.ts:210-214`, shown to everyone) cannot work: adding an email
channel inserts into a missing table → `create-failed` (`alerts.ts:250-259`).
Founder decision: deploy the alerts backend, or hide the section until it is.

**Process fact:** every SQL file is applied by hand in the dashboard SQL
editor; there is no `supabase/migrations/`, no `config.toml`, no CLI in
`package.json`, no CI step. Which files have been run is tracked only in prose
(`CLAUDE.md`, `M25-release-checklist.md`). Each edge function's header
documents `supabase functions deploy …`; none has ever been run.

### 2.2 Schema posture that matters for telemetry and entitlements

- Every table keys on `user_id uuid → auth.users(id)`; every RLS predicate is
  `auth.uid()`. **No grant to `anon` exists anywhere** — `backup-schema.sql:169`
  states "Not granted to anonymous visitors" as a design invariant.
- The email lives only in `auth.users` and, optionally,
  `notification_channels.address`. No `profiles` table, no
  `app_metadata`/roles/claims usage, no org/tenant concept.
- The shipped anon key is a valid HS256 JWT (`role: anon`, exp 2036), so a
  **session-less** supabase client passes gateway JWT verification as `anon`.
  That is what makes an anonymous ingest path possible without a new vendor.
- The existing server-to-server pattern (`alert-dispatcher`,
  `telegram-webhook`): deployed `--no-verify-jwt`, first statement compares a
  vendor header to a `Deno.env` secret, then a service-role client writes
  with RLS bypassed, idempotency in the DB. A Stripe webhook mirrors this
  exactly, except Stripe's signature is an HMAC over the raw body (read
  `req.text()` before parsing — `telegram-webhook` does `req.json()`).
- Aside, not deployed so moot today: `send-verification-email` /
  `send-test-alert-email` accept `{email}` and send to it without checking
  it belongs to the caller. Don't copy that shape.

### 2.3 Where the account identity is persisted locally (for the non-joinability invariant)

Exhaustive: **one place** — `%APPDATA%\sales-os\supabase-auth.json`, the
DPAPI-encrypted session blob (`auth.ts:95,122`) containing `user.id`,
`user.email`, `user_metadata`. Nothing else on disk carries the Supabase uid
or email: `backup-state.json` has none; local records "carry no `user.id`";
renderer never writes it to `localStorage`; no log writes it. (Calendar OAuth
caches hold the *calendar* account identity, which may differ.) No install
id / machine id / anonymous id exists anywhere yet.

**Stale doc found (taxonomy species 18):** the root `CLAUDE.md:73` still
describes the BUG-022 device-ownership guard (`device-owner.ts`,
`device-reset.ts`) as present. It was **deleted in `103a3ff` on 2026-08-11**
("per explicit product direction"). `docs/bugfix-once-and-for-all.md:64-68`
has the correction; the auto-loaded file does not.

### 2.4 What a minimal telemetry ingest looks like (design sketch, not built)

Table `telemetry_events(id uuid pk, anon_id uuid, app_version text, platform
text, event text, props jsonb, client_ts timestamptz, received_at timestamptz
default now())`, RLS on, **no select/update/delete for anyone but the SQL
editor/service role**. Two postures for the writer:

- **(A) Direct PostgREST insert as `anon`** — `grant insert … to anon` + an
  insert-only policy with `with check` constraints (payload size, event name
  length). Simplest; no deploy tooling; abuse control = Supabase's per-IP
  limits + a DB-side validator trigger. First `anon` grant in the project.
- **(B) Edge function `telemetry-ingest` as the only writer** — mirrors
  `alert_deliveries`'s "client can't write" posture; validates and
  normalises; service-role insert. Requires the project's first edge-function
  deploy (Supabase CLI login on the founder's machine — a new operational
  step to document).

Either way the **client side is where the invariant lives**: a brand-new
`telemetry-id.json` from `randomUUID()`, never derived from or written beside
`supabase-auth.json`; sent through a **separate, session-less** client
(`createClient(url, anonKey)` with no auth storage) — never
`getSupabaseClient()`, which would attach the user's JWT and let the server
see `auth.uid()`. The red-check for "cannot be joined to the email anywhere
in our schema" is then: the table has no `user_id` column, the function never
reads `Authorization`, and a test asserts the outbound request carries the
anon key and no user token.

---

## 3. electron-updater — publish flow and staged rollout

**Publish flow today** (`.github/workflows/release.yml`): bump
`package.json`, push tag `v*.*.*` (or `workflow_dispatch` with a version) →
`windows-latest` runner → `npm ci`, native addon, typecheck, `npx vitest run`,
`electron-vite build`, `gh release create` (pre-created to dodge a two-target
race), `electron-builder --win --x64 --publish always` → assets +
`latest.yml` on a **live** release. Failure diagnostics bundled as an
artifact. Releases v1.2.0 … v1.3.2 all went out this way (2026-08-14 …
08-18; `gh release list`).

**Staged rollout — verified, with evidence** (full detail and commands in
`M29-rollout-runbook.md`):

| Claim | Evidence |
|---|---|
| Our installed updater supports it | `node_modules/electron-updater/package.json` → 6.8.9; `out/AppUpdater.js:314-332` `isStagingMatch` |
| The field is typed and parsed from `latest.yml` | `builder-util-runtime/out/updateInfo.d.ts:60 stagingPercentage?: number`; `Provider.js:91-103` js-yaml load, no allowlist |
| It gates inside the path our code uses | `AppUpdater.js:351-354` in `isUpdateAvailable`, reached by `autoUpdater.checkForUpdates()` (`src/main/updater/index.ts:240,281`) |
| Our own strict gate doesn't reject the extra field | `policy.ts:validateUpdate` reads only `version/path/sha512` |
| The cohort id already exists on every install | `AppUpdater.js:501-527` → `userData/.updaterId`; present on this machine since 2026-08-11 |
| Outside-cohort users see "up to date" | `update-not-available` → `status = idle` (`index.ts:156-158`) |
| Ramp/halt = re-upload one asset | GitHubProvider fetches `releases/download/<tag>/latest.yml` of `/releases/latest` (`GitHubProvider.js:110-135`) |
| Zero-window variant is possible | `electron-publish/out/gitHubPublisher.js:69-71` returns an existing **draft** regardless of `releaseType` → create draft, let builder fill it, patch manifest, `gh release edit --draft=false` |

**Release-safety facts that cut the other way:**

- **Auto-update is off by default** (`app-settings.ts:742`). Checks happen
  only on a manual click, or every 6 h + 30 s after launch for opt-ins
  (`updater/index.ts:28-35,279-296`). Nothing in the renderer is told an
  update exists unless the user opens Settings → App. A kill-switch (remote
  flags) is therefore the only way to reach a user who never checks.
- No update failure reaches disk (§1.5) — the A2 "update success/failure"
  counter has to be added, not promoted.
- The updater sends `x-user-staging-id: <.updaterId>` to GitHub on every
  check (`AppUpdater.js:386-387`). Pre-existing; disclose it.
- Portable builds are outside any cohort and never auto-update.

---

## 4. First-run experience today (traced through the code; not screenshotted)

Honesty note: this is a code trace, not screenshots. The packaged app shares
`%APPDATA%\sales-os` with this machine's live install
(`index.ts:49-51`, unconditional — no env var or flag), so a "fresh" run here
would either show the founder's account or require touching live data. The
clean-machine pass is the B3 release gate and is not claimed here.

**The stranger's path, step by step:**

1. **Download** 350 MB `CallRise AI Windows.exe` from a GitHub release whose
   body reads "Automated release vX.Y.Z." (`release.yml:115`).
2. **SmartScreen.** The app is **unsigned** (no `certificateFile`/`CSC_LINK`
   anywhere). "Windows protected your PC," with the Run button hidden behind
   "More info." The only acknowledgement in the repo is a release-body
   string in the demo workflow (`build-windows-demo.yml:89`).
3. **Installer.** Assisted NSIS: install-for-me/all-users, directory page,
   finish with "Run CallRise AI" ticked. No license page, no custom copy.
4. **First window.** Dark 1280×832, pulsing-logo splash while auth status
   loads (`App.tsx:18-26`).
5. **Account wall — mandatory.** `App.tsx:49-55`: no user → `AuthScreen`.
   **There is no guest / try-without-account path.** "Log in" form; "New
   here? Create an account"; sign-up = name (optional), email, password
   (≥6); then "Confirm your email — Enter the code we emailed to …" (6–10
   digits). **No "Forgot password."** Two of the error strings are about the
   company's own SMTP failing (`auth.ts:183,194`) — they exist because it
   has happened.
6. **Onboarding** (`features/onboarding/`, gate = `localStorage
   ['salesos.onboarding.completedAt']`, replayable from Settings → App):
   Welcome → About you (name/role/pronoun) → What you sell → Recording
   (My side only / Both sides with consent; jurisdiction) → Microphone
   access (copy promises an OS prompt; **on Windows none appears** —
   `transcription.ts:1370` auto-grants) → Coaching cues → **"Add your
   Deepgram key — free to get, takes a minute — or skip"** → Done
   ("Start my first call" / "Explore the app"). Every middle step has
   "Skip for now."
7. **Home with zero calls.** Dismissible yellow banner "Live transcription
   needs a Deepgram key"; "Good morning"; "Start a live call"; "A quiet week
   so far"; three zero tiles; "No calls yet." **No checklist.** The Tier 1
   noise-cancellation card is Settings-only on Windows.
8. **First call without a key.** Click → **microphone is opened first**
   (`useTranscription.ts:593`) → then `no-key` → "Add your Deepgram API key —
   1. Create a free key at console.deepgram.com 2. Paste it into Settings →
   API keys **3. Restart the app**, then click Try again"
   (`LiveStates.tsx:137-160`). Settings says "Saved — takes effect
   immediately" (`ApiKeysSection.tsx:356`). Another banner says "Add your
   Deepgram API key to the .env file" (`LiveView.tsx:1050`) — meaningless in
   an installed app.
9. **First value** needs a second key: "Summarize" / "Coach this call" /
   "Generate tasks" with no text-AI key → "Add your **Anthropic** API key"
   (`CallDetail.tsx:1281-1292`, also `GenerateTasksDialog`, `RiskAssessmentCard`)
   although 8 providers work. No auto-summarize (all `auto*` prefs default
   off except auto-open). Rise (M28) is not on `main`.

**Who pays for what, verified:** Deepgram — **user's key**, no default,
DPAPI-encrypted in `%APPDATA%\sales-os\ai-keys\*.enc`; 8 text-AI providers —
**user's keys**; Supabase, Google/Outlook OAuth client ids, GitHub — company
(baked in, public by design). Live "Test key" exists for the 8 text providers;
**Deepgram has none** — a typo surfaces mid-call. **Sign-out wipes every
stored API key** (`auth.ts:416-426`).

**Rough edges, ranked by how likely each is to lose a stranger:**

| # | Edge | Where |
|---|---|---|
| 1 | SmartScreen on an unsigned 350 MB installer, nothing prepares them | `electron-builder.yml` (no signing) |
| 2 | Hard account wall + email code before any value; no forgot-password | `App.tsx:49-55`, `AuthScreen.tsx` |
| 3 | Zero value until they procure a Deepgram key themselves, then a second key for anything beyond transcript; onboarding lets them skip it so they hit the wall at step 8 | `ai-keys.ts`, `HomeView.tsx:57-66` |
| 4 | Contradictory key copy: "Restart the app" vs "takes effect immediately" vs ".env file"; "Anthropic key" where 8 providers work | `LiveStates.tsx:152`, `ApiKeysSection.tsx:356`, `LiveView.tsx:1050`, `CallDetail.tsx:1284` |
| 5 | Mic light comes on *before* the key check | `useTranscription.ts:593` vs `:648` |
| 6 | No Deepgram "Test key" | `ai-keys.ts:179-183` |
| 7 | Sign-out wipes all keys — "try again" re-enters everything | `auth.ts:416-426` |
| 8 | Recording step pre-selects "Both sides" (main default `true`); skip-before-load race persists `false` | `app-settings.ts:728`, `useOnboarding.ts:93-170` |
| 9 | Windows other-party capture known-unreliable behind the consent flow | `loopback.ts:7-22`, `docs/windows-capture.md` |
| 10 | Mic-permission step promises an OS prompt Windows never shows | `MicAccess.tsx:82` vs `transcription.ts:1370` |
| 11 | Updates invisible unless they find Settings → App; no changelog anywhere | `updater/index.ts:279-296` |
| 12 | Google Calendar connect may be blocked if the OAuth consent screen is still "Testing" — could not determine from code | `default-config.ts:15-20` |
| 13 | No post-onboarding checklist; Tier 1, detection and backup are footnotes | `steps/Done.tsx` |

**Settings map** (for slotting Telemetry / Billing / Support): Account ·
AI Setup (API keys, Model Assignment) · Meeting Assistant (AI Note Taker,
Call detection) · Recording · Audio (Tier 1, Export diagnostics, Test mic) ·
AI & coaching (7 pages) · Calendar · CRM · Alerts · App (Launch at login,
Replay setup, Open log file, notifications, concurrency, **Software update**)
· Appearance · Privacy & data · Developer (dev only). Natural home for the
new sections: a group between **App** and **Privacy**.

**What's New:** does not exist. No `CHANGELOG.md`, no in-app changelog, no
push to the renderer when an update lands; release notes exist only as
`docs/1.2.x-release-note.md` files.

---

## 5. Auth / account state and what entitlements need

**Today:** Supabase Auth, email + password, email-code confirmation
(`verifyOtp type:'signup'`), session persisted DPAPI-encrypted, refresh
automatic, renderer sees `{ id, email, name? }` only, main process owns the
client. No profiles, no roles, no claims, no metadata beyond `full_name`.
**Nothing subscription-shaped exists** — every grep hit for
subscription/plan/tier/trial/license/premium/billing/stripe is unrelated
vocabulary (Tier 0/1/2 deal intelligence, Tier 1 noise cancellation, AI
"free tier" quotas, the macOS entitlements plist).

**What B2 needs, from scratch (small):**

- A per-user row the client can **read but never write**:
  `entitlements(user_id uuid pk → auth.users, plan text, status text,
  current_period_end timestamptz, seats int, stripe_customer_id text,
  stripe_subscription_id text, updated_at)` + `select using (user_id =
  auth.uid())`, written only by a service-role webhook function (exactly
  `alert_deliveries`'s posture).
- A signed entitlement token the app caches (B2 decides length of the
  offline grace; the memo will propose). Signing key ≠ remote-flags key.
- Stripe ↔ user mapping: `client_reference_id = auth.uid` at Checkout-session
  creation, which needs a JWT-verified edge function that actually reads the
  caller's JWT (`createClient(url, anon, { global: { headers: {
  Authorization } } })` + `auth.getUser()`) — **none of the existing
  functions read the JWT**, so that's new code.
- One helper, `isEntitled(feature)`, as the only gate (brief's
  `cancellable:true` lesson).
- The pricing memo's Part G lists what must not be precluded (seats/org
  slot, a `free` plan, perpetual entitlements, a `managedAi` flag).

---

## 6. The three incidents → the A2 signal set (design basis)

| Incident | What happened | Silent for | Signal that catches it | Would it have caught it within days? |
|---|---|---|---|---|
| **BUG-080** — Sales Brain retrieval returned nothing for natural questions | cosine-vs-L2 threshold units bug, M25 → found by the M28 harness | ~9 days (2026-08-12 → 08-21) | `retrieval.query` counter: `{ resultCount: 0 \| >0, memoryCount bucket }` → "zero-result rate on installs with ≥ N memories" | **Yes, if the surface is used.** A 100% zero-result rate across every install with memories is unambiguous. Caveat: needs users asking questions (coaching chat / prep brief used retrieval then; Rise now). |
| **Sales Brain dead on clean Windows** — `ERROR_MOD_NOT_FOUND` for onnxruntime's VC++ runtime | worked on every dev box and CI runner; fixed `be512bc` 2026-08-14 | until a user reported it | `native.load` event at startup: `{ module: better-sqlite3 \| sqlite-vec \| onnxruntime \| win-audio-sessions \| mac-audio-activity, ok, errorClass }` | **Yes, on the first clean-machine launch** — minutes, not days. The clearest win in the set. |
| **1.3.0 Tier 1 gap** — engine shipped unconditionally ON with no settings surface; 1.3.1 an hour later | `380511c` (opt-in default) + `cf6a3b4` (UI) followed | ~1 h | `tier1.state` at call start: `{ enabled, engineAvailable, passthrough, reason }` per version | **Partly.** Telemetry shows the jump (0% → 100% engine-active between 1.2.6 and 1.3.0) and catches the `df_create`-failure passthrough case exactly (engine up, nothing denoised — the failure `electron-builder.yml` describes). It does **not** know "the user never chose this." The *missing UI* is a release-checklist + What's New (B5) catch: if you must write the changelog line, you notice there's no switch. |

Plus the brief's other signals, each with a source: AI purpose failure rate
by class (promote `ai-purpose-health.json` transitions), job failure rate by
type (promote `jobs-state.json` terminal states, **never** `resultData`),
update check/download/install outcome (new counters at the `updater/index.ts`
sites in §1.5), consent-flow errors (new counters at `consent-gate.ts:81-107`),
crash-free sessions (A1). Every one is a count or an enum — no free text, no
ids that identify a call, contact, or deal.

---

## 7. Items for the founder's decision (not acted on)

| # | Item | Kind |
|---|---|---|
| 1 | **Unmerged hotfixes on `main`:** `fix/rag-distance-units` (BUG-080, 1 commit), `fix/model-picker-assignable-purposes` (BUG-079, 1), `fix/contact-picker-outside-click` (3). v1.3.2 ships all three bugs. | merge / release |
| 2 | **Alerts backend never deployed** — Settings → Alerts is a dead section for everyone. Deploy (5 tables + 4 functions + pg_cron + Vault secret + Resend key) or hide the nav entry until then. | product |
| 3 | **`server_now()` not deployed** — re-run `backup-schema.sql` in the SQL editor (the M21 follow-up in CLAUDE.md, still open). Safe; app already tolerates its absence. | ops |
| 4 | **Auto-update off by default** — keep (privacy-conservative: no background GitHub request unless opted in) or flip for strangers (release safety). If kept, B3's onboarding should ask, and the What's New card should nudge. | product |
| 5 | **Root `CLAUDE.md:73` is stale** about the device-ownership guard. One-line doc fix; belongs in the end-of-milestone doc commit. | doc |
| 6 | `%TEMP%\callrise-startup-crash.log` grows forever (5 lines per launch, no cap), header says "remove once root-caused." Fold into A1. | A1 |
| 7 | Telemetry ingest posture A (direct anon insert) vs B (first edge-function deploy). Memo'd in §2.4; decide with A1's design. | A1 |

---

## 8. Verification state of this phase (claim audit)

| Claim | How verified | Environment | Result |
|---|---|---|---|
| Staged rollout works in our updater version | read `AppUpdater.js`, `updateInfo.d.ts`, `GitHubProvider.js`, `Provider.js` in the installed `node_modules` | this machine, `callrise-ai` checkout, electron-updater 6.8.9 | confirmed |
| `.updaterId` exists | `cat %APPDATA%\sales-os\.updaterId` | this machine | confirmed (2026-08-11) |
| Live `latest.yml` shape | `curl` of the v1.3.2 asset | GitHub, public | confirmed (no `stagingPercentage` today) |
| Draft releases are reused by the publisher | read `gitHubPublisher.js:63-71` | installed electron-publish 26.15.3 | confirmed — **the zero-window flow is designed, not tested**; test against a throwaway tag before trusting |
| Supabase deployed objects | anon REST/RPC/function probes | live project `fphvsuvpskqwkcpiocfz` | as tabled in §2.1; buckets **not** verifiable anonymously |
| First-run walkthrough | code trace | worktree @ `14969ab` | **not run, not screenshotted** — clean-machine pass is the B3 gate |
| Install base size | GitHub asset download counts | public | 18 manifest / 1 installer downloads on v1.3.2 — indicative only |
| Baseline typecheck | `npm run typecheck` | worktree, fresh `npm ci` | **exit 0** |
| Baseline suite (loaded machine) | `npm test` via `scripts/run-tests.mjs` | worktree, **machine under load** (4 agents + suite) | **exit 1** — 4 failed / 2074 passed / 9 skipped, all four 5–11 s timeouts (BUG-074 class). The same 4 files alone: **exit 0**, 37/37. |
| Baseline suite (idle machine) | `npm test` via `scripts/run-tests.mjs`, exit code captured with `$?` into the log | worktree, idle machine, fresh `npm ci` | **exit 0** — 206 files, 2078 passed / 9 skipped, 168 s. The loaded-run failures were starvation, not `main`. |
| Nothing was published, installed, or edited outside `docs/` | `git status` | worktree | three new docs + this file; no source changes |

Hollow-green species consciously checked this phase: **18** (privileged
stale doc — found one: `CLAUDE.md:73`), **16** (finding already written down
— the M21 `server_now()` follow-up *was* written down and still isn't done),
**19/20** (a verifier that can't fail — the suite exit code was read from the
log, not the summary line; the task wrapper's own exit 0 was *not* taken as
the suite's verdict).

---

## 9. Addendum (2026-08-24) — "audit for a fourth": every server-side dependency, probed

The founder's rule, stated after the third shipped-as-code-but-never-deployed
find: three instances of one shape found by accident means assume more exist.
So: every place the app depends on server-side state or a manually deployed
artifact, enumerated by grep, each probed against the LIVE project where a
probe exists. Result: **a fourth instance found within the hour (BUG-087).**
Taxonomy species 23 records the shape.

| Dependency | Needed by | Live? | Evidence (anon probes, 2026-08-24) |
|---|---|---|---|
| `backup_tasks/events/calls/knowledge/contacts/deals/deal_stages/settings` tables | cloud backup | ✅ | anon select → 200 |
| `attachments` storage bucket | call-attachment backup | ✅ | object probe → "Object not found" (bucket exists) |
| **`sales-brain` storage bucket** | **memory.db backup (M25)** | ❌ **BUG-087** | object probe → **"Bucket not found"** — every memory.db upload since M25 failed into a swallowed console.error; restore silently starts fresh |
| `server_now()` RPC | clock-skew correction (BUG-001 fix) | ❌ BUG-084 | RPC → PGRST202 |
| **`clock_skew_repaired` column** (M21 repair migration) | clock-skew repair | ❌ (same paste as BUG-084) | `?select=clock_skew_repaired` → 400 on backup_tasks/calls/settings |
| alerts tables ×5 + edge functions ×4 + pg_cron + Vault secret | Scheduled Alerts (M19) | ❌ BUG-083 | tables 404; functions NOT_FOUND. Decision: hidden until deployed |
| `telemetry_events` + trigger + view | M29 A1 | ⏳ pending founder paste | file drafted, unapplied |
| Supabase Auth (GoTrue) | sign-in | ✅ | `/auth/v1/health` → 200 |
| Supabase SMTP (signup codes) | account creation | ❓ unverifiable anonymously | two shipped error strings exist *because it broke before* (`auth.ts:183,194`); verify on the next clean-machine pass |
| Google OAuth consent screen published to "In production" | Calendar connect for strangers | ❓ unverifiable from code | `default-config.ts:15-21` says it starts in "Testing" (test users only); **founder: check Cloud Console** — if still Testing, every stranger's Google connect fails (B3 blocker) |
| Outlook app registration | Outlook connect | ✅ (in practice) | founder's own machine has synced Outlook |
| GitHub Releases + latest.yml | updater | ✅ | fetched live; v1.3.2 current |

**The founder's paste list for today is now THREE files** (all idempotent):
`supabase/backup-schema.sql` (BUG-084 + the repair column) ·
`supabase/2026-08-sales-brain-backup.sql` (BUG-087) ·
`supabase/2026-08-telemetry.sql` (A1). Verification per paste: `server_now()`
returns a timestamp / Storage shows `sales-brain/<uid>/memory.db` after a
"Sync now" / a telemetry row lands after "Send now".

**Standing fix so the class dies:** every SQL file ends by stamping
`schema_versions` (the telemetry file already does); a future A2 signal or
`--diagnose` line reads the stamps so "is the backend current?" is a check,
not a memory.
