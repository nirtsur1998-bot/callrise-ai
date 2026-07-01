-- ============================================================================
-- Sales OS — per-user cloud backup schema (M16, "cloud mirror")
--
-- Run this ONCE in your Supabase project's SQL editor
-- (Supabase dashboard → SQL Editor → New query → paste → Run).
-- It is SAFE TO RE-RUN: everything is create-if-not-exists / drop-then-create.
--
-- What it does: creates three private tables (one per synced store) and locks
-- them with Row-Level Security so each signed-in account can ONLY ever read or
-- write its OWN rows — never anyone else's.
--
-- Privacy: buyer transcripts and attachment files are NEVER stored here. The
-- app strips them before upload (that comes in a later step); this schema just
-- holds tasks, calendar events, and call metadata/summaries/quote-free coaching.
-- ============================================================================

-- Authoritative server timestamp. This trigger stamps `server_updated_at` on
-- every insert/update, so "newest wins" is decided by the SERVER's clock, never
-- a device's clock (which could be wrong and silently overwrite a newer edit).
create or replace function public.set_server_updated_at()
returns trigger
language plpgsql
set search_path = ''  -- pin the search path (Supabase best practice; silences the linter)
as $$
begin
  new.server_updated_at := now();  -- now() lives in pg_catalog, always in scope
  return new;
end;
$$;

-- --- Tables -----------------------------------------------------------------
-- Columns (identical for all three):
--   id                = the record's local id, reused forever (so re-syncs can't duplicate)
--   user_id           = the owner; must equal the signed-in user (enforced by RLS below)
--   updated_at        = the device's "last edited" time (informational / newest-wins input)
--   server_updated_at = authoritative server time, set by the trigger
--   deleted           = soft-delete tombstone; rows are NEVER hard-deleted
--   payload           = the record as JSON (buyer transcripts are NEVER included)
-- Primary key (user_id, id) keeps each account's ids in its own namespace.

create table if not exists public.backup_tasks (
  id                text        not null,
  user_id           uuid        not null references auth.users (id) on delete cascade,
  updated_at        timestamptz not null,
  server_updated_at timestamptz not null default now(),
  deleted           boolean     not null default false,
  payload           jsonb       not null,
  primary key (user_id, id)
);

create table if not exists public.backup_events (
  id                text        not null,
  user_id           uuid        not null references auth.users (id) on delete cascade,
  updated_at        timestamptz not null,
  server_updated_at timestamptz not null default now(),
  deleted           boolean     not null default false,
  payload           jsonb       not null,
  primary key (user_id, id)
);

create table if not exists public.backup_calls (
  id                text        not null,
  user_id           uuid        not null references auth.users (id) on delete cascade,
  updated_at        timestamptz not null,
  server_updated_at timestamptz not null default now(),
  deleted           boolean     not null default false,
  payload           jsonb       not null,
  primary key (user_id, id)
);

-- Helps the "pull only what changed since last time" query (a later step).
create index if not exists backup_tasks_user_server_updated
  on public.backup_tasks (user_id, server_updated_at);
create index if not exists backup_events_user_server_updated
  on public.backup_events (user_id, server_updated_at);
create index if not exists backup_calls_user_server_updated
  on public.backup_calls (user_id, server_updated_at);

-- --- Server-timestamp triggers ----------------------------------------------
drop trigger if exists trg_server_updated_at on public.backup_tasks;
create trigger trg_server_updated_at before insert or update on public.backup_tasks
  for each row execute function public.set_server_updated_at();

drop trigger if exists trg_server_updated_at on public.backup_events;
create trigger trg_server_updated_at before insert or update on public.backup_events
  for each row execute function public.set_server_updated_at();

drop trigger if exists trg_server_updated_at on public.backup_calls;
create trigger trg_server_updated_at before insert or update on public.backup_calls
  for each row execute function public.set_server_updated_at();

-- --- Row-Level Security (the lock) ------------------------------------------
-- Enable RLS, then allow each user to touch ONLY rows where user_id = their own
-- id (auth.uid() is the signed-in user's id). There is deliberately NO delete
-- policy, so rows can never be hard-deleted — deletions are recorded via the
-- `deleted` flag instead, and can't be lost.

alter table public.backup_tasks  enable row level security;
alter table public.backup_events enable row level security;
alter table public.backup_calls  enable row level security;

-- backup_tasks
drop policy if exists "own rows select" on public.backup_tasks;
create policy "own rows select" on public.backup_tasks
  for select using (user_id = auth.uid());
drop policy if exists "own rows insert" on public.backup_tasks;
create policy "own rows insert" on public.backup_tasks
  for insert with check (user_id = auth.uid());
drop policy if exists "own rows update" on public.backup_tasks;
create policy "own rows update" on public.backup_tasks
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- backup_events
drop policy if exists "own rows select" on public.backup_events;
create policy "own rows select" on public.backup_events
  for select using (user_id = auth.uid());
drop policy if exists "own rows insert" on public.backup_events;
create policy "own rows insert" on public.backup_events
  for insert with check (user_id = auth.uid());
drop policy if exists "own rows update" on public.backup_events;
create policy "own rows update" on public.backup_events
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- backup_calls
drop policy if exists "own rows select" on public.backup_calls;
create policy "own rows select" on public.backup_calls
  for select using (user_id = auth.uid());
drop policy if exists "own rows insert" on public.backup_calls;
create policy "own rows insert" on public.backup_calls
  for insert with check (user_id = auth.uid());
drop policy if exists "own rows update" on public.backup_calls;
create policy "own rows update" on public.backup_calls
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --- Grants -----------------------------------------------------------------
-- Signed-in users may select/insert/update these tables (RLS still restricts
-- them to their own rows). Not granted to anonymous visitors. No delete grant.
grant select, insert, update on public.backup_tasks  to authenticated;
grant select, insert, update on public.backup_events to authenticated;
grant select, insert, update on public.backup_calls  to authenticated;
