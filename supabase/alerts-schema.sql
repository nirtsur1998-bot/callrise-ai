-- ============================================================================
-- CallRise AI — Scheduled alerts (M19 Task 1)
--
-- Run this ONCE in your Supabase project's SQL editor
-- (Supabase dashboard → SQL Editor → New query → paste → Run).
-- Safe to re-run: everything is create-if-not-exists.
--
-- What this powers: reminders (meeting starting, task due, deal gone cold, no
-- next step booked) delivered to Telegram/email EVEN WHEN THE APP IS CLOSED.
-- A closed Electron app cannot run its own timers, so the source of truth for
-- "what's due" and the actual sending both live here, driven by pg_cron
-- (Database → Cron in the dashboard) calling the `alert-dispatcher` edge
-- function every minute.
--
-- Setup steps (after running this file):
--   1. Deploy the edge functions in supabase/functions/ (see each function's
--      own header comment for its specific setup).
--   2. Database → Cron → New cron job:
--        schedule: * * * * *  (every minute)
--        command:  select net.http_post(
--                    url := '<your-project-ref>.supabase.co/functions/v1/alert-dispatcher',
--                    headers := jsonb_build_object(
--                      'Authorization', 'Bearer ' || (select decrypted_secret
--                        from vault.decrypted_secrets where name = 'cron_dispatch_key'),
--                      'Content-Type', 'application/json'
--                    )
--                  );
--      Store the dispatch key in Vault (Database → Vault → New secret, name
--      'cron_dispatch_key') rather than inline — pg_net logs the full SQL
--      text of every call it makes, so an inline bearer token would leak into
--      the `net._http_response` log table in plaintext.
-- ============================================================================

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- --- notification_channels ---------------------------------------------------
-- One row per (user, channel type + address) the user has verified. Telegram
-- has no address up front — verification is inbound via webhook, so `address`
-- starts empty and is filled in once the bot binds a chat_id.
create table if not exists public.notification_channels (
  id                     uuid        primary key default gen_random_uuid(),
  user_id                uuid        not null references auth.users (id) on delete cascade,
  -- 'desktop' has no real address (a native notification "arrives" by the
  -- running app subscribing to Realtime, not by anyone pushing to it) — its
  -- row exists purely so alert_rule_channels can reference it like any other
  -- channel. Auto-created + auto-verified per user by the main process.
  type                   text        not null check (type in ('telegram', 'email', 'whatsapp', 'desktop')),
  -- Telegram: the chat_id (set once bound). Email/WhatsApp: the address/number.
  address                text,
  label                  text,                      -- user-facing name, e.g. "Personal Telegram"
  verified_at            timestamptz,
  verification_token     text,                      -- nonce (Telegram deep link) or code (email)
  verification_expires_at timestamptz,
  consecutive_failures   int         not null default 0,
  unhealthy_at           timestamptz,
  revoked_at             timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- A user can have several verified channels of the same type (e.g. two email
-- addresses) but the verification_token itself must be globally unique and
-- short-lived — it's the only thing the Telegram webhook has to look someone
-- up by, since the bot has no other way to know who ran /start.
create unique index if not exists notification_channels_token_idx
  on public.notification_channels (verification_token)
  where verification_token is not null;

-- --- alert_rules --------------------------------------------------------------
create table if not exists public.alert_rules (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references auth.users (id) on delete cascade,
  trigger_type      text        not null check (
                       trigger_type in ('meeting_starting', 'task_due', 'deal_cold', 'no_next_step')
                     ),
  -- Lead time in minutes for meeting_starting/task_due (1/5/10/15/30/60/custom).
  -- Meaningless for deal_cold/no_next_step, which have their own params below.
  lead_time_minutes int,
  enabled           boolean     not null default true,
  -- Free-form per-trigger config: deal_cold reads {days, digestHour}, e.g.
  -- {"days": 7, "digestHour": 9}. no_next_step reads {delayHours}, e.g.
  -- {"delayHours": 3}. Empty object for meeting_starting/task_due.
  params            jsonb       not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- --- alert_rule_channels (join table) -----------------------------------------
-- NOT an array column on alert_rules: an array of channel ids can't carry a
-- foreign key, so a revoked channel would leave a dangling reference that
-- silently no-ops instead of erroring or being cleaned up.
create table if not exists public.alert_rule_channels (
  rule_id    uuid not null references public.alert_rules (id) on delete cascade,
  channel_id uuid not null references public.notification_channels (id) on delete cascade,
  primary key (rule_id, channel_id)
);

-- --- alert_deliveries ----------------------------------------------------------
-- One row per (rule, subject, fire time, channel) — the unique constraint is
-- the entire idempotency mechanism. Cron overlaps, retries, and dispatcher
-- redeploys can all attempt to insert the same row; only the first succeeds.
create table if not exists public.alert_deliveries (
  id                uuid        primary key default gen_random_uuid(),
  rule_id           uuid        not null references public.alert_rules (id) on delete cascade,
  channel_id        uuid        not null references public.notification_channels (id) on delete cascade,
  -- What this alert is about: 'event' | 'task' | 'deal'. subject_id is that
  -- record's id in the app's own store (calendar event, task, or deal).
  subject_type      text        not null check (subject_type in ('event', 'task', 'deal')),
  subject_id        text        not null,
  -- Quantised fire moment (see header comment) — the idempotency key together
  -- with (rule_id, subject_id, channel_id).
  scheduled_fire_at timestamptz not null,
  dispatched_at     timestamptz,
  status            text        not null default 'pending' check (
                       status in ('pending', 'claimed', 'sent', 'failed', 'skipped_app_closed', 'held')
                     ),
  error             text,
  created_at        timestamptz not null default now(),
  unique (rule_id, subject_id, scheduled_fire_at, channel_id)
);

create index if not exists alert_deliveries_due_idx
  on public.alert_deliveries (scheduled_fire_at)
  where status = 'pending';

-- --- user_alert_settings -------------------------------------------------------
create table if not exists public.user_alert_settings (
  user_id                          uuid        primary key references auth.users (id) on delete cascade,
  timezone                         text        not null default 'UTC', -- IANA, e.g. 'America/New_York'
  quiet_hours_start                text,       -- 'HH:MM' in the user's timezone, null = no quiet hours
  quiet_hours_end                  text,
  quiet_hours_behavior             text        not null default 'hold' check (quiet_hours_behavior in ('hold', 'drop')),
  rate_limit_behavior              text        not null default 'queue' check (rate_limit_behavior in ('drop', 'queue', 'coalesce')),
  max_alerts_per_hour              int         not null default 20,
  deal_cold_days                   int         not null default 7,
  deal_cold_digest_hour            int         not null default 9, -- 0-23, user's local hour
  allow_server_side_brief_generation boolean   not null default false,
  updated_at                       timestamptz not null default now()
);

-- --- updated_at bookkeeping ----------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists notification_channels_touch on public.notification_channels;
create trigger notification_channels_touch
  before update on public.notification_channels
  for each row execute function public.touch_updated_at();

drop trigger if exists alert_rules_touch on public.alert_rules;
create trigger alert_rules_touch
  before update on public.alert_rules
  for each row execute function public.touch_updated_at();

drop trigger if exists user_alert_settings_touch on public.user_alert_settings;
create trigger user_alert_settings_touch
  before update on public.user_alert_settings
  for each row execute function public.touch_updated_at();

-- --- Row-Level Security ---------------------------------------------------------
alter table public.notification_channels enable row level security;
alter table public.alert_rules            enable row level security;
alter table public.alert_rule_channels    enable row level security;
alter table public.alert_deliveries       enable row level security;
alter table public.user_alert_settings    enable row level security;

drop policy if exists "own channels" on public.notification_channels;
create policy "own channels" on public.notification_channels
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rules" on public.alert_rules;
create policy "own rules" on public.alert_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- alert_rule_channels has no user_id column of its own — ownership is proven
-- by owning the referenced rule (and, on insert, the referenced channel too,
-- so a user can't link their rule to someone else's channel id).
drop policy if exists "own rule channels" on public.alert_rule_channels;
create policy "own rule channels" on public.alert_rule_channels
  for all using (
    exists (select 1 from public.alert_rules r where r.id = rule_id and r.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.alert_rules r where r.id = rule_id and r.user_id = auth.uid())
    and exists (select 1 from public.notification_channels c where c.id = channel_id and c.user_id = auth.uid())
  );

-- alert_deliveries: users may READ their own deliveries (for the in-app
-- "delivery history" / unhealthy-channel UI) but never write them directly —
-- only the dispatcher (via the service-role key, which bypasses RLS entirely)
-- creates/updates delivery rows. No insert/update/delete policy is defined,
-- so those are denied by default once RLS is enabled.
drop policy if exists "read own deliveries" on public.alert_deliveries;
create policy "read own deliveries" on public.alert_deliveries
  for select using (
    exists (select 1 from public.alert_rules r where r.id = rule_id and r.user_id = auth.uid())
  );

drop policy if exists "own alert settings" on public.user_alert_settings;
create policy "own alert settings" on public.user_alert_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- Dispatch functions — called by the alert-dispatcher edge function via the
-- service-role key (bypasses RLS deliberately: dispatch is cross-user by
-- nature). All of these run SECURITY DEFINER so they execute with the
-- privileges needed to read every user's rows, but each is careful to filter
-- by rule ownership/enabled state itself rather than relying on RLS.
--
-- Derive-at-dispatch, not materialize-ahead (see header comment): each derive
-- function looks at CURRENT state in the backup_* mirrors every time it runs
-- and upserts (ON CONFLICT DO NOTHING) the alert_deliveries row for whatever
-- is due — a cancelled/moved event or completed task simply stops matching
-- the query on the next tick, so nothing needs to be invalidated.
--
-- KNOWN LIMITATION (documented, not hidden): meeting_starting/task_due read
-- from backup_events/backup_tasks, which are only as fresh as the last M16
-- cloud-mirror push (on every local mutation, or a periodic tick while the
-- app is open) — NOT a live, continuously-synced server copy. A meeting
-- created or moved while the app has been closed for a while will not be
-- reflected here until the app is next opened and pushes. True continuous
-- server-side freshness needs the separate server-side Google/Outlook OAuth
-- + incremental sync (`syncToken`, tombstones, watch-channel renewal)
-- described in the M19 brief — that is a distinct, large piece of work,
-- deliberately not bundled into this schema.
-- ============================================================================

-- --- meeting_starting ---------------------------------------------------------
create or replace function public.derive_meeting_alerts()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.alert_deliveries (rule_id, channel_id, subject_type, subject_id, scheduled_fire_at)
  select
    r.id,
    rc.channel_id,
    'event',
    e.id,
    (e.payload->>'start')::timestamptz - make_interval(mins => r.lead_time_minutes)
  from public.alert_rules r
  join public.alert_rule_channels rc on rc.rule_id = r.id
  join public.notification_channels c on c.id = rc.channel_id and c.verified_at is not null and c.revoked_at is null
  join public.backup_events e on e.user_id = r.user_id
  where r.trigger_type = 'meeting_starting'
    and r.enabled = true
    and e.deleted = false
    and (e.payload->>'start') is not null
    and (e.payload->>'start')::timestamptz - make_interval(mins => r.lead_time_minutes)
        between now() - interval '1 hour' and now() + interval '60 seconds'
  on conflict (rule_id, subject_id, scheduled_fire_at, channel_id) do nothing;
end;
$$;

-- --- task_due -------------------------------------------------------------------
create or replace function public.derive_task_alerts()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.alert_deliveries (rule_id, channel_id, subject_type, subject_id, scheduled_fire_at)
  select
    r.id,
    rc.channel_id,
    'task',
    t.id,
    (t.payload->>'dueAt')::timestamptz - make_interval(mins => r.lead_time_minutes)
  from public.alert_rules r
  join public.alert_rule_channels rc on rc.rule_id = r.id
  join public.notification_channels c on c.id = rc.channel_id and c.verified_at is not null and c.revoked_at is null
  join public.backup_tasks t on t.user_id = r.user_id
  where r.trigger_type = 'task_due'
    and r.enabled = true
    and t.deleted = false
    and (t.payload->>'status') = 'open'
    and (t.payload->>'dueAt') is not null
    and (t.payload->>'dueAt')::timestamptz - make_interval(mins => r.lead_time_minutes)
        between now() - interval '1 hour' and now() + interval '60 seconds'
  on conflict (rule_id, subject_id, scheduled_fire_at, channel_id) do nothing;
end;
$$;

-- --- deal_cold --------------------------------------------------------------------
-- Quantised to ONE digest per day at the user's configured hour, in the
-- user's own timezone (both from user_alert_settings) — see the header
-- comment: without pinning a single instant, a "no natural fire moment"
-- trigger either re-fires every tick or never fires at all.
--
-- "No contact in N days" reads the deal's own updated_at as the proxy for
-- last activity (deal edits, stage changes, risk assessments all touch it).
-- A more precise "days since last CALL" would join backup_calls on
-- payload->>'dealId', which is a reasonable follow-up refinement once calls
-- are confirmed to carry that link reliably in the payload.
create or replace function public.derive_deal_cold_alerts()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.alert_deliveries (rule_id, channel_id, subject_type, subject_id, scheduled_fire_at)
  select
    r.id,
    rc.channel_id,
    'deal',
    d.id,
    -- Today's digest instant in the user's own timezone, converted to UTC.
    (date_trunc('day', now() at time zone coalesce(s.timezone, 'UTC'))
      + make_interval(hours => coalesce(s.deal_cold_digest_hour, 9)))
      at time zone coalesce(s.timezone, 'UTC')
  from public.alert_rules r
  join public.alert_rule_channels rc on rc.rule_id = r.id
  join public.notification_channels c on c.id = rc.channel_id and c.verified_at is not null and c.revoked_at is null
  join public.backup_deals d on d.user_id = r.user_id
  left join public.user_alert_settings s on s.user_id = r.user_id
  where r.trigger_type = 'deal_cold'
    and r.enabled = true
    and d.deleted = false
    and coalesce((d.payload->>'stageKind'), 'open') = 'open' -- payload carries denormalized stage kind if present
    and d.updated_at < now() - make_interval(days => coalesce((r.params->>'days')::int, 7))
    -- Only fire once we've actually reached (or passed) today's digest hour.
    and now() >= (date_trunc('day', now() at time zone coalesce(s.timezone, 'UTC'))
      + make_interval(hours => coalesce(s.deal_cold_digest_hour, 9)))
      at time zone coalesce(s.timezone, 'UTC')
  on conflict (rule_id, subject_id, scheduled_fire_at, channel_id) do nothing;
end;
$$;

-- --- no_next_step -------------------------------------------------------------------
-- Fires once, `delayHours` after a call with no follow-up task linked to it
-- (payload->>'callId' on backup_tasks). scheduled_fire_at is pinned to
-- call-end-time + delayHours, which is the one natural, reproducible instant
-- this trigger has.
create or replace function public.derive_no_next_step_alerts()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.alert_deliveries (rule_id, channel_id, subject_type, subject_id, scheduled_fire_at)
  select
    r.id,
    rc.channel_id,
    'deal',
    call.id,
    (call.payload->>'endedAt')::timestamptz + make_interval(hours => coalesce((r.params->>'delayHours')::int, 3))
  from public.alert_rules r
  join public.alert_rule_channels rc on rc.rule_id = r.id
  join public.notification_channels c on c.id = rc.channel_id and c.verified_at is not null and c.revoked_at is null
  join public.backup_calls call on call.user_id = r.user_id
  where r.trigger_type = 'no_next_step'
    and r.enabled = true
    and call.deleted = false
    and (call.payload->>'endedAt') is not null
    and (call.payload->>'endedAt')::timestamptz + make_interval(hours => coalesce((r.params->>'delayHours')::int, 3))
        between now() - interval '1 hour' and now() + interval '60 seconds'
    and not exists (
      select 1 from public.backup_tasks t
      where t.user_id = r.user_id and t.deleted = false and (t.payload->>'callId') = call.id
    )
  on conflict (rule_id, subject_id, scheduled_fire_at, channel_id) do nothing;
end;
$$;

-- --- Claim (SKIP LOCKED) -----------------------------------------------------------
-- Atomically claims due, pending deliveries and returns everything the edge
-- function needs to actually send — the ONE place overlapping cron ticks or
-- concurrent dispatcher invocations can't double-send the same row, since a
-- locked row is invisible to a second concurrent claim rather than blocking on it.
create or replace function public.claim_due_deliveries(batch_size int default 50)
returns table (
  delivery_id uuid,
  rule_id uuid,
  user_id uuid,
  trigger_type text,
  params jsonb,
  channel_id uuid,
  channel_type text,
  channel_address text,
  subject_type text,
  subject_id text,
  scheduled_fire_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.alert_deliveries ad
  set status = 'claimed'
  from public.alert_rules r, public.notification_channels c
  where ad.id in (
    -- 'desktop' channels are never claimed here: nothing server-side can raise
    -- a native OS notification. Their rows stay 'pending' for the running
    -- app's own Realtime subscription to pick up and mark 'sent' itself; see
    -- expire_stale_desktop_deliveries() for the "app wasn't running" case.
    select ad2.id
    from public.alert_deliveries ad2
    join public.notification_channels c2 on c2.id = ad2.channel_id
    where ad2.status = 'pending'
      and ad2.scheduled_fire_at <= now() + interval '60 seconds'
      and c2.type <> 'desktop'
    order by ad2.scheduled_fire_at asc
    limit batch_size
    for update of ad2 skip locked
  )
  and r.id = ad.rule_id
  and c.id = ad.channel_id
  returning
    ad.id, r.id, r.user_id, r.trigger_type, r.params,
    c.id, c.type, c.address,
    ad.subject_type, ad.subject_id, ad.scheduled_fire_at;
end;
$$;

-- A desktop-channel delivery that's sat 'pending' well past its fire time was
-- never picked up by a running app's Realtime subscription — the app was
-- closed. Per the M19 spec: mark it skipped and never replay it (a reminder
-- for a meeting that already happened is worse than nothing).
create or replace function public.expire_stale_desktop_deliveries()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.alert_deliveries ad
  set status = 'skipped_app_closed', dispatched_at = now()
  from public.notification_channels c
  where c.id = ad.channel_id
    and c.type = 'desktop'
    and ad.status = 'pending'
    and ad.scheduled_fire_at < now() - interval '2 minutes';
end;
$$;

-- Lets a signed-in client mark its OWN desktop delivery as handled once the
-- native notification has actually been raised — the one delivery-status
-- write a non-service-role client is allowed to make (RLS on alert_deliveries
-- otherwise denies all writes; SECURITY DEFINER + the ownership check below
-- is the deliberate, narrow exception).
create or replace function public.ack_desktop_delivery(p_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.alert_deliveries ad
  set status = 'sent', dispatched_at = now()
  from public.alert_rules r, public.notification_channels c
  where ad.id = p_delivery_id
    and r.id = ad.rule_id
    and c.id = ad.channel_id
    and c.type = 'desktop'
    and r.user_id = auth.uid() -- only the owning signed-in user may ack their own row
    and ad.status = 'pending';
end;
$$;

-- Realtime: the running app subscribes to INSERTs on this table (filtered by
-- its own RLS-visible rows) to notice new desktop-channel deliveries as they
-- appear. Must ALSO be turned on in Dashboard → Database → Replication if
-- this statement doesn't take effect on your Supabase plan.
alter publication supabase_realtime add table public.alert_deliveries;

-- --- Result recording ---------------------------------------------------------------
create or replace function public.mark_delivery_result(
  p_delivery_id uuid,
  p_status text, -- 'sent' | 'failed' | 'held' | 'skipped_app_closed'
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channel_id uuid;
begin
  update public.alert_deliveries
  set status = p_status, dispatched_at = now(), error = p_error
  where id = p_delivery_id
  returning channel_id into v_channel_id;

  if p_status = 'sent' then
    update public.notification_channels
    set consecutive_failures = 0, unhealthy_at = null
    where id = v_channel_id;
  elsif p_status = 'failed' then
    update public.notification_channels
    set consecutive_failures = consecutive_failures + 1,
        unhealthy_at = case when consecutive_failures + 1 >= 3 then now() else unhealthy_at end
    where id = v_channel_id;
  end if;
end;
$$;
