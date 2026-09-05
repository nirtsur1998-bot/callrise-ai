-- ============================================================================
-- Sales OS — Objection review queue backup (BUG-189, September 2026)
--
-- WHY THIS EXISTS. objection-queue/ (the staging area between objection
-- mining and the Knowledge Base — on the founder's own profile 95 items,
-- 460 KB) was in no synced store: the backup reconciles tasks, events, calls,
-- conversations, knowledge, contacts and deals, and this directory was none of
-- them. Every un-reviewed candidate died with the machine, silently — and the
-- saved calls' `objectionsMinedAt` flags DID sync, so a restored machine said
-- "already mined" over an empty queue.
--
-- CONSENT. The queue stores the buyer's words verbatim (objectionQuote). It is
-- mined from the SAVED call record, AFTER applyConsentRetention has stripped
-- every other-party segment from a call whose consent does not permit
-- recording them — so it cannot hold words the consent gate would strip
-- (checked on the founder's data before this was written: 95 of 95 items from
-- consented calls, 0 strip cases). It syncs under the SAME opt-in toggle as
-- transcripts (Settings → Privacy & data → "Call recordings & transcripts"),
-- and switching that toggle off deletes every row here in the same scrub that
-- re-pushes the calls quote-free.
--
-- Run this ONCE in the Supabase SQL editor. Only this table's statements —
-- same reasoning as 2026-09-rise-conversations-backup.sql. Safe to re-run.
--
-- UNTIL THIS RUNS, the app degrades safely: the push and pull each sit in
-- their own try/catch and report their own step; a missing table never fails
-- the rest of a sync.
-- ============================================================================

-- Same shape and rules as backup_tasks/events/calls/contacts/deals. Unlike
-- backup_rise_conversations, `deleted` is REAL here: rejecting or approving an
-- item, and deleting its source call, write a tombstone (quotes dropped) that
-- propagates, so a rejected candidate does not come back from the cloud.
create table if not exists public.backup_objection_queue (
  id                text        not null,
  user_id           uuid        not null references auth.users (id) on delete cascade,
  updated_at        timestamptz not null,
  server_updated_at timestamptz not null default now(),
  deleted           boolean     not null default false,
  payload           jsonb       not null,
  primary key (user_id, id)
);

create index if not exists backup_objection_queue_user_server_updated
  on public.backup_objection_queue (user_id, server_updated_at);

drop trigger if exists trg_server_updated_at on public.backup_objection_queue;
create trigger trg_server_updated_at
  before insert or update on public.backup_objection_queue
  for each row execute function public.set_server_updated_at();

alter table public.backup_objection_queue enable row level security;

drop policy if exists "own rows select" on public.backup_objection_queue;
create policy "own rows select" on public.backup_objection_queue
  for select using (user_id = auth.uid());

drop policy if exists "own rows insert" on public.backup_objection_queue;
create policy "own rows insert" on public.backup_objection_queue
  for insert with check (user_id = auth.uid());

drop policy if exists "own rows update" on public.backup_objection_queue;
create policy "own rows update" on public.backup_objection_queue
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- The transcripts scrub deletes this user's rows outright when the toggle is
-- switched off — the ONE backup table with a delete policy, because a
-- tombstone would still be a row carrying the item's id and call id after the
-- user asked for the words to leave the cloud. Scoped to auth.uid() like the
-- rest; the service role is never used from the app.
drop policy if exists "own rows delete" on public.backup_objection_queue;
create policy "own rows delete" on public.backup_objection_queue
  for delete using (user_id = auth.uid());

grant select, insert, update, delete on public.backup_objection_queue to authenticated;

-- ============================================================================
-- VERIFY, after running the above and letting one sync happen with the
-- transcripts toggle ON:
--
--   select count(*) filter (where not deleted), count(*) filter (where deleted),
--          max(server_updated_at)
--   from public.backup_objection_queue;
--
-- Expected on the founder's profile: 95 live rows on the first push.
-- ============================================================================
