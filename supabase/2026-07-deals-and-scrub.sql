-- ============================================================================
-- Sales OS — deals backup + privacy-scrub permissions (July 2026 additions)
--
-- Run this ONCE in the Supabase SQL editor. It contains ONLY the statements
-- added for the deals-backup and scrub-on-toggle-off features, so it can't be
-- derailed by earlier sections of backup-schema.sql (whose storage-policy
-- statements can fail with "must be owner of table objects" on newer Supabase
-- projects, aborting the run before the new tables are ever created).
--
-- Safe to re-run: everything is create-if-not-exists / drop-then-create.
-- ============================================================================

-- 1. backup_deals: same shape/rules as backup_tasks/events/calls/contacts.
create table if not exists public.backup_deals (
  id                text        not null,
  user_id           uuid        not null references auth.users (id) on delete cascade,
  updated_at        timestamptz not null,
  server_updated_at timestamptz not null default now(),
  deleted           boolean     not null default false,
  payload           jsonb       not null,
  primary key (user_id, id)
);

create index if not exists backup_deals_user_server_updated
  on public.backup_deals (user_id, server_updated_at);

drop trigger if exists trg_server_updated_at on public.backup_deals;
create trigger trg_server_updated_at before insert or update on public.backup_deals
  for each row execute function public.set_server_updated_at();

alter table public.backup_deals enable row level security;

drop policy if exists "own rows select" on public.backup_deals;
create policy "own rows select" on public.backup_deals
  for select using (user_id = auth.uid());
drop policy if exists "own rows insert" on public.backup_deals;
create policy "own rows insert" on public.backup_deals
  for insert with check (user_id = auth.uid());
drop policy if exists "own rows update" on public.backup_deals;
create policy "own rows update" on public.backup_deals
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update on public.backup_deals to authenticated;

-- 2. backup_deal_stages: exactly ONE row per user (the pipeline's stage list).
create table if not exists public.backup_deal_stages (
  user_id           uuid        not null references auth.users (id) on delete cascade,
  updated_at        timestamptz not null,
  server_updated_at timestamptz not null default now(),
  payload           jsonb       not null,
  primary key (user_id)
);

drop trigger if exists trg_server_updated_at on public.backup_deal_stages;
create trigger trg_server_updated_at before insert or update on public.backup_deal_stages
  for each row execute function public.set_server_updated_at();

alter table public.backup_deal_stages enable row level security;

drop policy if exists "own row select" on public.backup_deal_stages;
create policy "own row select" on public.backup_deal_stages
  for select using (user_id = auth.uid());
drop policy if exists "own row insert" on public.backup_deal_stages;
create policy "own row insert" on public.backup_deal_stages
  for insert with check (user_id = auth.uid());
drop policy if exists "own row update" on public.backup_deal_stages;
create policy "own row update" on public.backup_deal_stages
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update on public.backup_deal_stages to authenticated;

-- 3. Delete permissions for the scrub-on-toggle-off feature (opt-in
--    categories only; tasks/events/calls keep their no-hard-delete rule).
drop policy if exists "own rows delete" on public.backup_knowledge;
create policy "own rows delete" on public.backup_knowledge
  for delete using (user_id = auth.uid());
grant delete on public.backup_knowledge to authenticated;

drop policy if exists "own rows delete" on public.backup_contacts;
create policy "own rows delete" on public.backup_contacts
  for delete using (user_id = auth.uid());
grant delete on public.backup_contacts to authenticated;

drop policy if exists "own rows delete" on public.backup_deals;
create policy "own rows delete" on public.backup_deals
  for delete using (user_id = auth.uid());
grant delete on public.backup_deals to authenticated;

drop policy if exists "own row delete" on public.backup_deal_stages;
create policy "own row delete" on public.backup_deal_stages
  for delete using (user_id = auth.uid());
grant delete on public.backup_deal_stages to authenticated;

drop policy if exists "own row delete" on public.backup_settings;
create policy "own row delete" on public.backup_settings
  for delete using (user_id = auth.uid());
grant delete on public.backup_settings to authenticated;

-- 4. LAST (may fail on newer Supabase projects with "must be owner of table
--    objects" — if it does, everything above still applied; add this one
--    policy via Dashboard → Storage → attachments bucket → Policies instead:
--    allow DELETE for authenticated users where the first folder equals their
--    user id).
drop policy if exists "own attachment delete" on storage.objects;
create policy "own attachment delete" on storage.objects
  for delete using (
    bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text
  );
