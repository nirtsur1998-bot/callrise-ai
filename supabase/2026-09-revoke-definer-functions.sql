-- ============================================================================
-- 2026-09 — LOCK DOWN EVERY SECURITY DEFINER FUNCTION  (BUG-210, BUG-213)
--
-- Run this whole file once, in the Supabase SQL editor, against the CallRise
-- project. It only ever REMOVES privileges and then grants back the minimum,
-- so it cannot expose anything that is not already exposed.
--
-- ---------------------------------------------------------------------------
-- WHY. Postgres grants EXECUTE on every new function to the PUBLIC role by
-- default. `security definer` then makes that function run with the OWNER's
-- rights, ignoring row-level security. So a definer function with no explicit
-- revoke is callable by ANYONE who can reach PostgREST — including a holder of
-- the anon key, which is embedded in the shipped desktop app and extractable
-- in seconds.
--
-- BUG-213, and this one is LIVE, measured against the deployed project on
-- 2026-09-07 with the anon key and no user session:
--
--     GET /rest/v1/rpc/telemetry_prune
--     -> 405, {"code":"25006","message":"cannot execute SELECT in a
--              read-only transaction"}
--
-- That is not a permission denial. It is Postgres refusing to run the
-- function's DELETE inside the read-only transaction PostgREST uses for GET —
-- which means the permission check had already PASSED. A POST would have run
-- it. `telemetry_prune()` is `security definer` and deletes telemetry rows.
--
-- The existing revoke, at 2026-08-telemetry.sql:259, is:
--
--     revoke all on function public.telemetry_prune() from anon, authenticated;
--
-- and it leaves the built-in PUBLIC grant completely untouched. Revoking from
-- a role that inherits the privilege from PUBLIC removes nothing. `from
-- public` is the one that matters, and the same file gets it RIGHT twelve
-- lines earlier for telemetry_ingest_batch — which is what makes this a slip
-- rather than a misunderstanding, and exactly the kind that survives review.
--
-- BUG-210, not live but loaded: alerts-schema.sql defines EIGHT definer
-- functions and contains ZERO grant or revoke statements of any kind. It has
-- never been deployed (verified: every one of its functions returns 404 on
-- this project), so running it as written would be the moment the exposure
-- begins. One of them, claim_due_deliveries, returns rows joined to
-- notification_channels, which holds each user's email address, Telegram chat
-- id or phone number.
--
-- SAFE TO RE-RUN. Every statement is idempotent.
--
-- IMPORTANT, AND IT IS THE PART MOST LIKELY TO BE FORGOTTEN: `create or
-- replace function` RESETS a function's privileges to the default. So this
-- file must be re-run after ANY deployment that replaces one of these
-- functions. The test in src/__tests__/definer-functions-are-revoked.test.ts
-- fails when a definer function in this tree has no matching revoke, which
-- catches the source side; nothing but re-running this catches the deployed
-- side.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. BUG-213 — the live one. Correct the incomplete telemetry revoke.
-- ---------------------------------------------------------------------------
-- `from public` is the addition. Without it the previous revoke was a no-op.

revoke all on function public.telemetry_prune() from public, anon, authenticated;

-- telemetry_ingest_batch was already revoked `from public` correctly. Adding
-- authenticated makes the file's own stated intent true — it says anon may
-- INSERT and nothing else, and that authenticated gets nothing at all — and
-- the grant below is the one the app actually uses.
revoke all on function public.telemetry_ingest_batch(jsonb) from public, anon, authenticated;
grant execute on function public.telemetry_ingest_batch(jsonb) to anon;


-- ---------------------------------------------------------------------------
-- 2. BUG-210 — the alerts functions, before that schema is ever deployed.
-- ---------------------------------------------------------------------------
-- These will ERROR with "function does not exist" until alerts-schema.sql has
-- been run. That is expected and is not a problem: run this file again after
-- deploying alerts, and it will apply. It is written this way rather than
-- wrapped in existence checks so that a failure is VISIBLE — a silently
-- skipped revoke is how the gap got here.
--
-- The signatures matter. A revoke whose argument list does not match the
-- function exactly is an error, not a silent no-op, which is the good failure
-- direction. Note that DEFAULTS are never written in a revoke:
-- `claim_due_deliveries(batch_size int default 50)` is revoked as `(int)`, and
-- `mark_delivery_result`'s third argument must still be listed even though it
-- defaults to null.

revoke all on function public.derive_meeting_alerts() from public, anon, authenticated;
revoke all on function public.derive_task_alerts() from public, anon, authenticated;
revoke all on function public.derive_deal_cold_alerts() from public, anon, authenticated;
revoke all on function public.derive_no_next_step_alerts() from public, anon, authenticated;
revoke all on function public.claim_due_deliveries(int) from public, anon, authenticated;
revoke all on function public.expire_stale_desktop_deliveries() from public, anon, authenticated;
revoke all on function public.mark_delivery_result(uuid, text, text) from public, anon, authenticated;
revoke all on function public.ack_desktop_delivery(uuid) from public, anon, authenticated;

-- Then grant back exactly what each caller needs, and nothing more.
-- The alert dispatcher runs as service_role; only the desktop acknowledgement
-- is called by a signed-in user.
grant execute on function public.derive_meeting_alerts() to service_role;
grant execute on function public.derive_task_alerts() to service_role;
grant execute on function public.derive_deal_cold_alerts() to service_role;
grant execute on function public.derive_no_next_step_alerts() to service_role;
grant execute on function public.claim_due_deliveries(int) to service_role;
grant execute on function public.expire_stale_desktop_deliveries() to service_role;
grant execute on function public.mark_delivery_result(uuid, text, text) to service_role;
grant execute on function public.ack_desktop_delivery(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. The alerts TABLES, which have the same omission one level up.
-- ---------------------------------------------------------------------------
-- alerts-schema.sql enables row-level security on all five tables and gives
-- each one policies, which is right. But it contains no grants at all, so on
-- Supabase all five inherit the project default that grants anon and
-- authenticated everything. Row-level security is then the ONLY thing between
-- the shipped anon key and other users' notification addresses.
--
-- That is one misconfiguration away from an exposure rather than two, and
-- backup-schema.sql does not rely on it: it grants explicitly, fourteen times.
-- Match it.

revoke all on public.notification_channels from anon;
revoke all on public.alert_rules from anon;
revoke all on public.alert_rule_channels from anon;
revoke all on public.alert_deliveries from anon;
revoke all on public.user_alert_settings from anon;

grant select, insert, update, delete on public.notification_channels to authenticated;
grant select, insert, update, delete on public.alert_rules to authenticated;
grant select, insert, update, delete on public.alert_rule_channels to authenticated;
grant select on public.alert_deliveries to authenticated;
grant select, insert, update on public.user_alert_settings to authenticated;


-- ============================================================================
-- VERIFY — run these after the above.
-- ============================================================================
--
--   -- 1. No SECURITY DEFINER function may be executable by anon or PUBLIC.
--   --    This should return ZERO rows. Any row is a finding.
--   select p.proname,
--          pg_get_function_identity_arguments(p.oid) as args,
--          coalesce(array_to_string(p.proacl, ', '), 'DEFAULT (= PUBLIC can execute)') as acl
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.prosecdef
--     and (p.proacl is null
--          or has_function_privilege('anon', p.oid, 'execute'));
--
--   -- 2. telemetry_prune specifically, the live one.
--   select has_function_privilege('anon', 'public.telemetry_prune()', 'execute')
--          as anon_can_still_prune;   -- must be false
--
--   -- 3. anon must hold no privilege on any alerts table.
--   select table_name, privilege_type
--   from information_schema.role_table_grants
--   where grantee = 'anon'
--     and table_name in ('notification_channels','alert_rules',
--                        'alert_rule_channels','alert_deliveries',
--                        'user_alert_settings');   -- must return zero rows
-- ============================================================================
