-- ============================================================================
-- 2026-09 — LOCK DOWN EVERY SECURITY DEFINER FUNCTION  (BUG-213, BUG-210)
--
-- Run this whole file in the Supabase SQL editor, against the CallRise
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
-- BUG-213 IS LIVE. Measured against this project on 2026-09-07 with the anon
-- key and no user session:
--
--     GET /rest/v1/rpc/telemetry_prune
--     -> 405 {"code":"25006","message":"cannot execute SELECT in a
--             read-only transaction"}
--
-- That is not a permission denial. It is Postgres refusing to run the
-- function's DELETE inside the read-only transaction PostgREST uses for GET —
-- the permission check had already PASSED. A POST would have run it.
-- `telemetry_prune()` is `security definer` and deletes telemetry rows.
--
-- The cause is one word. 2026-08-telemetry.sql:259 reads
--     revoke all on function public.telemetry_prune() from anon, authenticated;
-- which removes NOTHING, because both roles inherit EXECUTE from PUBLIC. The
-- same file gets it right twelve lines earlier for telemetry_ingest_batch.
--
-- BUG-210, not live but loaded: alerts-schema.sql defines eight definer
-- functions and contains ZERO grant or revoke statements. It has never been
-- deployed here (verified: its functions return 404), so running it as written
-- would be the moment the exposure begins. One of them, claim_due_deliveries,
-- returns rows joined to notification_channels, which holds each user's email
-- address, Telegram chat id or phone number.
--
-- ---------------------------------------------------------------------------
-- WHY EVERY SECTION IS GUARDED BY AN EXISTENCE CHECK, which is the change
-- made on 2026-09-08 before this was first run.
--
-- The alerts objects DO NOT EXIST on this project. A bare `revoke ... on
-- function public.derive_meeting_alerts()` would raise "function does not
-- exist", the SQL editor would abort the script at that line, and every
-- statement after it — including the alerts table grants — would silently not
-- run. Worse, the telemetry fix is the FIRST section, so it would appear to
-- have worked while the run as a whole reported an error, which is exactly the
-- kind of half-applied migration nobody goes back and re-reads.
--
-- So each object is applied only if it exists, and the script RAISES A NOTICE
-- naming what it skipped. Re-run this file after deploying alerts-schema.sql
-- and the skipped half applies.
--
-- SAFE TO RE-RUN, always.
--
-- ONE THING THIS CANNOT PROTECT AND IT WILL BITE: `create or replace function`
-- RESETS a function's privileges to the default. Re-run this file after ANY
-- deployment that replaces one of these functions.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. BUG-213 — the LIVE one. Correct the incomplete telemetry revoke.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.telemetry_prune()') is not null then
    -- `from public` is the whole fix. Without it the previous revoke was a
    -- no-op, because anon and authenticated both inherit from PUBLIC.
    revoke all on function public.telemetry_prune() from public, anon, authenticated;
    raise notice 'telemetry_prune: revoked from PUBLIC (this is BUG-213, the live one)';
  else
    raise notice 'SKIPPED telemetry_prune — not deployed on this project';
  end if;

  if to_regprocedure('public.telemetry_ingest_batch(jsonb)') is not null then
    -- Already revoked from public correctly; adding authenticated makes the
    -- file's own stated intent true (anon may INSERT, authenticated gets
    -- nothing). The grant below is the one the app actually uses.
    revoke all on function public.telemetry_ingest_batch(jsonb) from public, anon, authenticated;
    grant execute on function public.telemetry_ingest_batch(jsonb) to anon;
    raise notice 'telemetry_ingest_batch: revoked, execute re-granted to anon only';
  else
    raise notice 'SKIPPED telemetry_ingest_batch — not deployed on this project';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 2. BUG-210 — the alerts functions. Expected to be SKIPPED today.
-- ---------------------------------------------------------------------------
-- Signatures matter: a revoke whose argument list does not match is an error,
-- not a silent no-op. DEFAULTS are never written in a signature, so
-- `claim_due_deliveries(batch_size int default 50)` is `(int)`, and
-- `mark_delivery_result`'s third argument is still listed even though it
-- defaults to null.
do $$
declare
  fn text;
  service_fns text[] := array[
    'public.derive_meeting_alerts()',
    'public.derive_task_alerts()',
    'public.derive_deal_cold_alerts()',
    'public.derive_no_next_step_alerts()',
    'public.claim_due_deliveries(int)',
    'public.expire_stale_desktop_deliveries()',
    'public.mark_delivery_result(uuid, text, text)'
  ];
  -- The one a signed-in user genuinely calls: the desktop acknowledging a
  -- delivery it displayed.
  user_fns text[] := array['public.ack_desktop_delivery(uuid)'];
  skipped int := 0;
begin
  foreach fn in array service_fns loop
    if to_regprocedure(fn) is not null then
      execute format('revoke all on function %s from public, anon, authenticated', fn);
      execute format('grant execute on function %s to service_role', fn);
    else
      skipped := skipped + 1;
    end if;
  end loop;

  foreach fn in array user_fns loop
    if to_regprocedure(fn) is not null then
      execute format('revoke all on function %s from public, anon', fn);
      execute format('grant execute on function %s to authenticated', fn);
    else
      skipped := skipped + 1;
    end if;
  end loop;

  if skipped > 0 then
    raise notice 'SKIPPED % alerts function(s) — alerts-schema.sql is not deployed. Re-run this file after deploying it.', skipped;
  else
    raise notice 'alerts functions: all 8 locked down';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 3. The alerts TABLES. Also expected to be SKIPPED today.
-- ---------------------------------------------------------------------------
-- alerts-schema.sql enables row-level security on all five and gives each
-- policies, which is right. But it contains no grants at all, so on Supabase
-- all five inherit the project default that grants anon and authenticated
-- everything, and RLS becomes the ONLY thing between the shipped anon key and
-- other users' notification addresses. That is one misconfiguration away from
-- an exposure rather than two, and backup-schema.sql does not rely on it: it
-- grants explicitly, fourteen times. Match it.
do $$
declare
  rec record;
  skipped int := 0;
begin
  for rec in
    select * from (values
      ('notification_channels', 'select, insert, update, delete'),
      ('alert_rules',           'select, insert, update, delete'),
      ('alert_rule_channels',   'select, insert, update, delete'),
      ('alert_deliveries',      'select'),
      ('user_alert_settings',   'select, insert, update')
    ) as t(tbl, privs)
  loop
    if to_regclass('public.' || rec.tbl) is not null then
      execute format('revoke all on public.%I from anon', rec.tbl);
      execute format('grant %s on public.%I to authenticated', rec.privs, rec.tbl);
    else
      skipped := skipped + 1;
    end if;
  end loop;

  if skipped > 0 then
    raise notice 'SKIPPED % alerts table(s) — alerts-schema.sql is not deployed.', skipped;
  end if;
end $$;


-- ============================================================================
-- 4. VERIFY, in the same run. This SELECT is the proof, and it is the last
--    statement so its result grid is what the editor shows.
--
--    HOW TO READ IT, corrected 2026-09-08 after the first run: it is NOT
--    "every row must be false". This file itself GRANTS execute back to anon
--    for telemetry_ingest_batch, because that is how the desktop app ships
--    telemetry — it posts batches with the anon key and no user session. So
--    that row reads true BY DESIGN.
--
--    The instruction as first written said every row must read false, which
--    would have made the correct outcome look like a finding. Recorded rather
--    than quietly reworded, because a verification step that cries wolf on a
--    good result gets ignored on a bad one.
--
--    THE RULE: anon_can_execute must be false for every definer function
--    EXCEPT telemetry_ingest_batch(jsonb). Any other true is a finding.
--
--    Result of the first run, 2026-09-08:
--      telemetry_ingest_batch(rows jsonb)  anon=true   <- by design
--      telemetry_prune()                   anon=false  <- BUG-213 fixed
--      (the 8 alerts functions did not appear: not deployed, so skipped)
--
--    Confirmed independently with the shipped anon key and no session, which
--    is how the bug was found in the first place:
--      before  GET /rest/v1/rpc/telemetry_prune -> 405 25006 (permission PASSED)
--      after   GET /rest/v1/rpc/telemetry_prune -> 401 42501 permission denied
-- ============================================================================
select
  p.proname                                                as function_name,
  pg_get_function_identity_arguments(p.oid)                as arguments,
  has_function_privilege('anon', p.oid, 'execute')          as anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
  coalesce(array_to_string(p.proacl, ', '), 'DEFAULT — PUBLIC can execute') as acl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
order by has_function_privilege('anon', p.oid, 'execute') desc, p.proname;
