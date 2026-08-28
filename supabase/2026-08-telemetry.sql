-- ============================================================================
-- CallRise AI — opt-in anonymous telemetry (M29 Workstream A1/A4)
--
-- Run this ONCE in the Supabase dashboard → SQL Editor → New query → Run.
-- Safe to re-run: everything is create-if-not-exists / create-or-replace.
--
-- WHAT THIS IS. One write-only table that the desktop app inserts into, ONLY
-- after the user opted in (Settings → Privacy → Diagnostics & telemetry).
-- Rows carry a random per-install id, a per-launch session id, the app and
-- OS versions, and small structured events (crash/error/health/usage). They
-- never carry a user id, an email, or any content — see the client side in
-- src/main/telemetry/ and docs/M29-A1-plan.md.
--
-- IDENTITY SEPARATION, ENFORCED BY THE SCHEMA. There is no user_id column,
-- no foreign key to auth.users, and the only policy is an INSERT policy for
-- the `anon` role. A row cannot be joined to an account because there is
-- nothing in it to join on. Reads happen only from the SQL editor / the
-- service role (i.e. the founder), never from the app.
--
-- THIS IS THE PROJECT'S FIRST GRANT TO `anon`. backup-schema.sql states
-- "Not granted to anonymous visitors" as an invariant for the backup tables;
-- that stays true — this table is the one deliberate exception, and it is
-- insert-only with a validating trigger (below) so the public anon key can
-- add rows but never read, change, or delete them, and never add a row that
-- doesn't match the allowed shape.
-- ============================================================================

create table if not exists public.telemetry_events (
  id           uuid        primary key default gen_random_uuid(),
  -- The app's own event id (idempotency: a retried batch must not double-count).
  event_id     uuid        not null unique,
  -- Random per-install id from userData/telemetry-id. NOT the account, NOT .updaterId.
  anon_id      uuid        not null,
  -- Random per-launch id. "Crash-free sessions" = sessions with no crash row.
  session_id   uuid        not null,
  app_version  text        not null check (app_version ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'),
  platform     text        not null check (platform in ('win32', 'darwin', 'linux')),
  os_version   text        not null check (length(os_version) <= 64),
  arch         text        not null check (length(arch) <= 16),
  kind         text        not null check (kind in ('crash', 'error', 'health', 'usage')),
  name         text        not null check (name ~ '^[a-z][a-zA-Z0-9]*([.-][a-zA-Z0-9]+){0,7}$' and length(name) <= 64),
  props        jsonb       not null default '{}'::jsonb,
  client_ts    timestamptz not null,
  -- Server clock; the only timestamp trusted for time-series queries.
  received_at  timestamptz not null default now()
);

create index if not exists telemetry_events_version_received
  on public.telemetry_events (app_version, received_at);
create index if not exists telemetry_events_session
  on public.telemetry_events (session_id);
create index if not exists telemetry_events_name_received
  on public.telemetry_events (name, received_at);

-- ---------------------------------------------------------------------------
-- Validating trigger: props may hold only strings, numbers and booleans — no
-- nested objects, no arrays — with short keys and bounded string lengths.
-- The client enforces the same shape (src/main/telemetry/events.ts); this is
-- the server refusing to trust the client, because the anon key is public.
-- ---------------------------------------------------------------------------
create or replace function public.telemetry_validate_props()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  k text;
  v jsonb;
  n int := 0;
begin
  if jsonb_typeof(new.props) <> 'object' then
    raise exception 'telemetry: props must be an object';
  end if;
  for k, v in select * from jsonb_each(new.props) loop
    n := n + 1;
    if n > 24 then
      raise exception 'telemetry: too many props';
    end if;
    if k !~ '^[a-zA-Z][a-zA-Z0-9_]{0,31}$' then
      raise exception 'telemetry: bad prop key';
    end if;
    case jsonb_typeof(v)
      when 'string' then
        if (k = 'stack' and length(v #>> '{}') > 4100) or (k <> 'stack' and length(v #>> '{}') > 260) then
          raise exception 'telemetry: string prop too long';
        end if;
      when 'number' then null;
      when 'boolean' then null;
      else
        raise exception 'telemetry: prop % has unsupported type %', k, jsonb_typeof(v);
    end case;
  end loop;
  -- Never trust a client-supplied received_at.
  new.received_at := now();
  return new;
end;
$$;

drop trigger if exists trg_telemetry_validate on public.telemetry_events;
create trigger trg_telemetry_validate
  before insert on public.telemetry_events
  for each row execute function public.telemetry_validate_props();

-- ---------------------------------------------------------------------------
-- Access: anon may INSERT and nothing else. authenticated gets nothing at
-- all (the app never sends a user token to this table; if it ever did, the
-- absence of an authenticated policy means the insert would fail loudly).
-- ---------------------------------------------------------------------------
alter table public.telemetry_events enable row level security;

revoke all on public.telemetry_events from anon, authenticated;
grant insert on public.telemetry_events to anon;

drop policy if exists "anon insert only" on public.telemetry_events;
create policy "anon insert only" on public.telemetry_events
  for insert to anon
  with check (true);
-- No select / update / delete policy for any client role. Deliberate.
--
-- CONFIRMED 2026-08-28, against the live cutover project: the client's
-- `?on_conflict=event_id` + `Prefer: resolution=ignore-duplicates` upsert
-- (transport.ts's idempotent-retry shape) does NOT work against a bare
-- insert-only grant. Postgres's `ON CONFLICT` needs to visibility-check the
-- existing row, which fails as `42501 permission denied` with no SELECT
-- grant, or as `42501 new row violates row-level security policy` if SELECT
-- is granted but (correctly) has zero permissive policies -- both tried and
-- reverted live, confirmed with curl before and after. This was telemetry's
-- first-ever live traffic (see the hollow-green taxonomy, "a subsystem can
-- be complete, tested, shipped, and have never once executed") and it had
-- never been exercised through this exact code path before.
--
-- DO NOT "fix" this by granting SELECT to anon -- it does not solve the
-- ON CONFLICT problem and it is an unnecessary privilege widening for an
-- insert-only table.
--
-- The tempting client-only fix -- drop `on_conflict`, treat a `409`/`23505`
-- unique-violation as "already delivered" -- is UNSAFE and was rejected
-- before shipping: a batch is one atomic multi-row INSERT, so ONE
-- already-delivered event_id anywhere in a batch of up to 100 aborts the
-- WHOLE batch, including genuinely new events. Because the local queue only
-- drops an event on a CONFIRMED ack, and new events keep accumulating
-- alongside any stuck ones, a batch that mixes already-delivered and
-- brand-new events is a realistic case here, not a hypothetical -- treating
-- the whole batch's 409 as "all delivered" would silently and permanently
-- drop the new ones. Real per-row idempotency needs the RPC below.

-- ---------------------------------------------------------------------------
-- The anon-safe upsert path. SECURITY DEFINER runs as the function owner
-- (full table access), so the per-row `ON CONFLICT DO NOTHING` inside it can
-- visibility-check existing rows without anon ever being granted SELECT --
-- the caller gets back nothing but a row count, never row contents. Each
-- insert still fires trg_telemetry_validate exactly as a direct table
-- insert would; nothing about validation is duplicated or bypassed here.
--
-- Per-row, not one bulk statement, so one already-delivered event_id cannot
-- abort the rest of the batch the way a single multi-row INSERT would.
create or replace function public.telemetry_ingest_batch(rows jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
  inserted int := 0;
begin
  if jsonb_typeof(rows) <> 'array' then
    raise exception 'telemetry_ingest_batch: rows must be a JSON array';
  end if;
  for r in select * from jsonb_array_elements(rows) loop
    insert into public.telemetry_events (
      event_id, anon_id, session_id, app_version, platform, os_version, arch,
      kind, name, props, client_ts
    ) values (
      (r->>'event_id')::uuid,
      (r->>'anon_id')::uuid,
      (r->>'session_id')::uuid,
      r->>'app_version',
      r->>'platform',
      r->>'os_version',
      r->>'arch',
      r->>'kind',
      r->>'name',
      coalesce(r->'props', '{}'::jsonb),
      (r->>'client_ts')::timestamptz
    )
    on conflict (event_id) do nothing;
    if found then
      inserted := inserted + 1;
    end if;
  end loop;
  return inserted;
end;
$$;

revoke all on function public.telemetry_ingest_batch(jsonb) from public;
grant execute on function public.telemetry_ingest_batch(jsonb) to anon;

-- ---------------------------------------------------------------------------
-- A4.1 — version health. Queryable from the SQL editor:
--   select * from public.telemetry_version_health order by app_version desc;
-- A session is "crashed" if it produced any crash-kind row or a main-process
-- uncaught exception. Sessions are counted from session.start rows, so an
-- install that never opted in is simply absent, not a zero.
-- ---------------------------------------------------------------------------
create or replace view public.telemetry_version_health as
with sessions as (
  select app_version, platform, session_id, min(received_at) as started_at
  from public.telemetry_events
  where name = 'session.start'
  group by app_version, platform, session_id
),
crashed as (
  select distinct session_id
  from public.telemetry_events
  where kind = 'crash' or name = 'error.main-uncaughtexception'
)
select
  s.app_version,
  s.platform,
  count(*)                                          as sessions_30d,
  count(*) filter (where c.session_id is not null)  as crashed_sessions_30d,
  round(100.0 * count(*) filter (where c.session_id is null) / greatest(count(*), 1), 2)
                                                    as crash_free_pct_30d,
  count(*) filter (where s.started_at > now() - interval '7 days')
                                                    as sessions_7d,
  count(*) filter (where s.started_at > now() - interval '7 days' and c.session_id is not null)
                                                    as crashed_sessions_7d,
  count(distinct e.anon_id)                         as installs_30d,
  max(s.started_at)                                 as last_seen
from sessions s
left join crashed c on c.session_id = s.session_id
left join public.telemetry_events e on e.session_id = s.session_id and e.name = 'session.start'
where s.started_at > now() - interval '30 days'
group by s.app_version, s.platform;

-- The view is for the dashboard only — no client role can read it.
revoke all on public.telemetry_version_health from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Hygiene: rows older than 90 days are not useful for release safety and are
-- deleted by this function. Schedule it from Database → Cron if pg_cron is
-- enabled (daily is plenty):
--   select cron.schedule('telemetry-prune', '0 4 * * *', $$select public.telemetry_prune()$$);
-- ---------------------------------------------------------------------------
create or replace function public.telemetry_prune()
returns bigint
language sql
security definer
set search_path = ''
as $$
  with d as (
    delete from public.telemetry_events
    where received_at < now() - interval '90 days'
    returning 1
  )
  select count(*) from d;
$$;
revoke all on function public.telemetry_prune() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Schema stamp (BUG-084's lesson: nothing records which SQL files were run).
-- ---------------------------------------------------------------------------
create table if not exists public.schema_versions (
  name       text primary key,
  applied_at timestamptz not null default now()
);
revoke all on public.schema_versions from anon, authenticated;
insert into public.schema_versions (name) values ('2026-08-telemetry.sql')
  on conflict (name) do update set applied_at = now();
