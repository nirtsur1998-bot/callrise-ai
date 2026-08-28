# Decision memo — Settings → Alerts has been dead since M19 (BUG-083) and `server_now()` has been inert since v1.0.0 (BUG-084)

**Status:** DECISION MEMO. The founder chooses; nothing below is built.
**Date:** 2026-08-23. Both bugs have their own entries in the vault's Bug
Tracker (BUG-083 🟠, BUG-084 🟡), not folded into M29's general findings.

---

## BUG-083 — the Alerts section

### What a user sees today (verified against the live project)

Settings → Alerts → "Scheduled alerts" is listed for every user
(`settings-nav.ts:210-214`). Inside it:

| Action | What happens | Why |
|---|---|---|
| Add an **email** channel | "Could not send the verification code — try again." Retrying never helps. | insert into `notification_channels` → table does not exist on the live project (HTTP 404) |
| Add a **Telegram** channel | "Telegram isn't configured for this app yet (missing bot credentials)." | `TELEGRAM_BOT_TOKEN` is not in the shipped config — honest, at least |
| Create a **rule** | the save silently fails (no error surface in `AlertRulesCard`/`useAlerts`) | `alert_rules` does not exist |
| Quiet hours / settings | fails | `user_alert_settings` does not exist |
| Recent deliveries | empty forever | `alert_deliveries` does not exist |

So every control on the page fails. It has been this way since M19 merged
(2026-08-04). M19's own vault note said, at the time: *"Genuinely blocked on
the user's own action: run the SQL, deploy the edge functions, create a
Telegram bot + Resend account, set the env vars + pg_cron job."* The client
half shipped; the server half was never done. Taxonomy species 16 — the
finding that was already written down.

### What "deploy it now" actually requires

Not a single command. Eight steps, three of them outside the repo:

| # | Step | Who | Effort | Notes |
|---|---|---|---|---|
| 1 | Paste `supabase/alerts-schema.sql` (511 lines) into the dashboard SQL editor | founder | 5 min | needs `pg_cron` + `pg_net` extensions — both available on the free plan |
| 2 | Install the Supabase CLI, `supabase login`, `supabase link --project-ref emsbcxwzbjttxpimvlnj` | founder | 20 min first time | ref updated by the 2026-08-28 cutover. The old ref (`fphvsuvpskqwkcpiocfz`) is the RETIRED project — linking to it would deploy functions somewhere the app no longer talks to, and it would look like it worked. The project has never had a CLI deploy |
| 3 | `supabase functions deploy` × 4 (two with `--no-verify-jwt`) | founder (or me, if the CLI is logged in on this machine) | 10 min | |
| 4 | **Resend account** — a new vendor | founder | 30 min + DNS | free tier 3,000 emails/mo — but sending to anyone other than yourself requires a **verified sending domain** (SPF + DKIM records on a domain you own). Without that, email alerts only ever reach the founder. |
| 5 | **Telegram bot** via BotFather + webhook registration with the secret token | founder | 15 min | free |
| 6 | `supabase secrets set` for `CRON_DISPATCH_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_ADDRESS` | founder | 5 min | |
| 7 | Vault secret `cron_dispatch_key` + the every-minute pg_cron job in the dashboard | founder | 10 min | `alerts-schema.sql:15-31` has the exact SQL |
| 8 | **Code fix before Telegram goes live:** `src/main/alert-channels/telegram.ts:18` reads the **bot token inside the desktop app** for "send test alert." A token in a desktop app is extractable by anyone; the test-send must move behind an edge function. | me | half a day + tests | this is a real security item, not polish |

Plus two product facts the M19 note recorded and a stranger would hit:

- `meeting_starting` / `task_due` alerts read from the **cloud-backup mirror
  tables**, so they only work for users with cloud backup switched on, and
  are only as fresh as the last sync.
- The server-side prep-brief enrichment for closed-app alerts was
  "deferred pending sign-off" and is still unbuilt.

**Total: roughly a founder afternoon in dashboards, a domain with DNS
access, one new vendor, and a half-day code fix — before a single alert
can be tested end-to-end for the first time.**

### What "hide it until it's real" requires

- Remove the `alerts` entry from `settings-nav.ts` behind one constant
  (`ALERTS_BACKEND_LIVE = false`) so un-hiding is a one-line change, keep
  every file, keep the IPC registered (harmless when unused).
- One test: the nav list does not contain `alerts` while the constant is
  false, and does when it's true (proves the switch is wired — species 17).
- Check nothing else links into the section (Home cards, onboarding's
  "Done" footer mentions nothing about alerts — verified in the first-run
  audit).
- Ships as its own hotfix branch off `main`, ~10 lines + test, same day.

### Recommendation: **hide now, deploy as its own scoped item later**

Reasons, in order of weight:

1. **The lie stops today.** Hiding is an hour; deploying is an afternoon of
   the founder's dashboard time plus a domain, and the page keeps lying
   until every one of the eight steps is done.
2. **Email alerts for strangers need a verified domain.** If there is no
   domain with DNS access ready, "deploy now" gives email alerts that reach
   only the founder — the page would still be lying, just differently.
3. **Telegram has a security defect to fix first** (the client-side bot
   token). Deploying before that ships a token to every install.
4. **Alerts are a cloud feature** — the one category of feature that costs
   us money per user (cron every minute, email sends). The pricing memo's
   structures put cloud features on the paid tier. Deploying them *after*
   B1/B2 lets them launch as something that pays for itself, with the
   entitlement gate already in place.
5. **A milestone is the right container.** A real alerts launch wants: the
   eight steps as a checklist, the Telegram fix, an end-to-end test from a
   second machine, a deploy script so the SQL-by-hand problem (§BUG-084)
   stops recurring, and the "only works with backup on" caveat either fixed
   or stated in the UI. That's a scoped item, not a side quest inside a
   telemetry milestone.

If the founder prefers **deploy now**: steps 1–7 are theirs (I can't log in
to Supabase or create vendor accounts), step 8 is mine first, and I'd want
the Telegram fix merged *before* the secrets are set. I'd also want the
section to stay hidden until an end-to-end alert has been received on a
second machine — "deployed" and "works" are different claims.

---

## BUG-084 — `server_now()` never deployed

**What it is:** M21's clock-skew fix (BUG-001) measures skew via a
`server_now()` RPC. The RPC was never created on the live project, so the
app has taken the safe fallback ("skew unmeasurable → 0 correction →
pre-M21 behaviour") in every shipped build. A device with a wrong clock is
back in BUG-001's failure mode: a genuinely newer cloud copy may never be
restored.

**Proof from the founder's own machine:** `%APPDATA%\sales-os\backup-state.json`
shows `lastSyncAt: 2026-08-23T17:46:46Z` with `clockSkewMs: null` and
`clockSkewCheckedAt: null` — a sync ran today and skew was unmeasurable,
exactly the fallback path.

**What fixing it requires:** paste `supabase/backup-schema.sql` into the
dashboard SQL editor and run it. The file is idempotent (`create or replace`,
`if not exists`, the repair migration is guarded by a `clock_skew_repaired`
flag). Five minutes, zero risk, founder's dashboard.

**Recommendation: do it today, regardless of the Alerts decision.** Then
verify from the app: Settings → Privacy → cloud backup → "Sync now," and the
`backup-state.json` `clockSkewMs` / `clockSkewCheckedAt` fields stop being null. I can check that
file from here once you've run it.

**Root cause to fix once, not per incident:** every SQL file is applied by
hand and nothing records which have been run. The cheapest durable fix is a
`schema_versions` table (plural — corrected 2026-08-24; only `2026-08-telemetry.sql` stamps it today, see `M29-sweep-findings.md`) that each SQL file stamps at its end, plus a `--diagnose`
line that reads it — so "is the backend current?" becomes a check rather
than a memory. Proposed as an A2 health signal (`backend.schemaVersion`) and
as the first line of any future deploy script.

---

## Decisions

| # | Question | Options | Lean |
|---|---|---|---|
| 1 | Alerts section | **hide now** / deploy now / leave as-is | hide now, as a same-day hotfix off `main` |
| 2 | When to deploy alerts for real | after B2 (as a paid cloud feature) / its own mini-milestone / never | after B2, with the eight-step checklist and the Telegram fix |
| 3 | `server_now()` | run `backup-schema.sql` today | yes |
| 4 | Schema-version stamp | add to A2 | yes |
