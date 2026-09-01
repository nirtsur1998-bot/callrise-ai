-- ============================================================================
-- Sales OS — Rise conversation backup (BUG-157, September 2026)
--
-- WHY THIS EXISTS. Rise assistant conversations had NO backup path of any kind.
-- backup.ts syncs from the database, while conversations-fs.ts deliberately
-- keeps Rise threads as flat JSON OUTSIDE memory.db (so chat survives with
-- Sales Brain off, and without the native modules behind the 1.2.1-1.2.4
-- clean-Windows saga). Both decisions are correct; nothing bridged them. Every
-- Rise thread was therefore local-only and died with the machine — silently,
-- because the app backs up calls, contacts, deals, tasks, events, knowledge and
-- settings, so nobody had reason to suspect otherwise.
--
-- Measured on the founder's own profile before the fix: 10 conversations, 18
-- messages, 8 of them client-scoped, spanning 2026-08-23 to 2026-09-01.
--
-- Run this ONCE in the Supabase SQL editor. It contains ONLY the statements for
-- this one table, so it cannot be derailed by earlier sections of
-- backup-schema.sql (whose storage-policy statements can fail with "must be
-- owner of table objects" on newer projects, aborting the run before the new
-- table is ever created) — same reasoning as 2026-07-deals-and-scrub.sql.
--
-- Safe to re-run: everything is create-if-not-exists / drop-then-create.
--
-- UNTIL THIS RUNS, the app degrades safely rather than breaking: the push and
-- pull each sit in their own try/catch and report their own step, exactly like
-- backup_deals, so a missing table never fails the rest of a sync.
-- ============================================================================

-- Same shape and rules as backup_tasks/events/calls/contacts/deals.
--
-- The `deleted` column is present for shape-compatibility with every other
-- backup table and with reconcileStore's row contract, but the app currently
-- always writes false: the conversation store has no tombstone, because
-- deleteConversation() unlinks the file. A deletion on one machine therefore
-- does NOT propagate — the other device still holds its copy and will push it
-- back. Making deletion sync needs a `deleted` flag on the record itself plus a
-- sweep, which is a client-side schema change, not something this table can fix.
create table if not exists public.backup_rise_conversations (
  id                text        not null,
  user_id           uuid        not null references auth.users (id) on delete cascade,
  updated_at        timestamptz not null,
  server_updated_at timestamptz not null default now(),
  deleted           boolean     not null default false,
  payload           jsonb       not null,
  primary key (user_id, id)
);

create index if not exists backup_rise_conversations_user_server_updated
  on public.backup_rise_conversations (user_id, server_updated_at);

drop trigger if exists trg_server_updated_at on public.backup_rise_conversations;
create trigger trg_server_updated_at
  before insert or update on public.backup_rise_conversations
  for each row execute function public.set_server_updated_at();

alter table public.backup_rise_conversations enable row level security;

-- Row-level security is the whole protection here: a conversation payload is
-- chat text, at least as sensitive as the transcripts that sit behind their own
-- opt-in toggle. Every policy is scoped to auth.uid(), and there is deliberately
-- no delete policy — same as every other backup table, deletions travel as a
-- flag rather than as a DELETE.
drop policy if exists "own rows select" on public.backup_rise_conversations;
create policy "own rows select" on public.backup_rise_conversations
  for select using (user_id = auth.uid());

drop policy if exists "own rows insert" on public.backup_rise_conversations;
create policy "own rows insert" on public.backup_rise_conversations
  for insert with check (user_id = auth.uid());

drop policy if exists "own rows update" on public.backup_rise_conversations;
create policy "own rows update" on public.backup_rise_conversations
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update on public.backup_rise_conversations to authenticated;

-- ============================================================================
-- VERIFY, after running the above and letting one sync happen:
--
--   select count(*), max(server_updated_at)
--   from public.backup_rise_conversations;
--
-- and that RLS really is scoping rows (run as an authenticated user, not the
-- service role — the service role bypasses RLS and would prove nothing):
--
--   select count(*) from public.backup_rise_conversations;   -- own rows only
-- ============================================================================
