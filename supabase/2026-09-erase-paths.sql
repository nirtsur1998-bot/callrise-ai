-- ============================================================================
-- 2026-09 — THE TWO MISSING ERASE PATHS  (BUG-200, BUG-202)
--
-- Run this whole file once, in the Supabase SQL editor, against the CallRise
-- project. It grants exactly two deletes and nothing else.
--
-- WHY IT IS NEEDED. Seven categories of data can be backed up. Five of them
-- can be removed again when the user switches them off. Two could not, and
-- they were exactly the two that default ON:
--
--   salesBrain         -> the whole memory.db (skill weaknesses, stated
--                         struggles, the rep's own onboarding answers)
--   riseConversations  -> Rise chat threads, in the user's own words
--
-- In both cases the client had no scrub branch AND the backend had no delete
-- permission, so "turn it off" stopped future uploads and left everything
-- already uploaded in place, permanently. The client half ships with this
-- change; without the two policies below, the client's delete is refused by
-- row-level security and the scrub stays queued and retries forever — which
-- is the correct failure, but it never succeeds.
--
-- A NOTE ON THE COMMENT THIS CORRECTS. 2026-09-rise-conversations-backup.sql
-- says of that table: "there is deliberately no delete policy — same as every
-- other backup table, deletions travel as a flag rather than as a DELETE."
-- The justification is not true. backup_knowledge, backup_contacts,
-- backup_deals, backup_deal_stages, backup_settings and backup_objection_queue
-- all have a delete policy and a delete grant today, and the client's scrub
-- issues real DELETEs against them. This file makes the two stragglers match
-- the six.
--
-- SAFE TO RE-RUN: every statement is drop-if-exists then create.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. BUG-202 — Rise conversations: let a user delete their own rows
-- ---------------------------------------------------------------------------
-- Same shape as backup_knowledge / backup_contacts / backup_settings: scoped to
-- auth.uid(), so a user can only ever delete their own rows.

drop policy if exists "own rows delete" on public.backup_rise_conversations;
create policy "own rows delete" on public.backup_rise_conversations
  for delete using (user_id = auth.uid());

grant delete on public.backup_rise_conversations to authenticated;


-- ---------------------------------------------------------------------------
-- 2. BUG-200 — the Sales Brain blob: let a user delete their own objects
-- ---------------------------------------------------------------------------
-- The brain is one object per user in the 'sales-brain' Storage bucket at
-- "<user_id>/memory.db". This is the same policy the 'attachments' bucket has
-- had since 2026-07 (see 2026-07-deals-and-scrub.sql), which is why the
-- attachment scrub works and this one could not.
--
-- IF THIS ERRORS with "must be owner of table objects": everything above still
-- applied. Add this one policy through the Dashboard instead —
-- Storage -> sales-brain bucket -> Policies -> allow DELETE for authenticated
-- users where the first folder equals their user id.

drop policy if exists "own sales-brain db delete" on storage.objects;
create policy "own sales-brain db delete" on storage.objects
  for delete using (
    bucket_id = 'sales-brain' and (storage.foldername(name))[1] = auth.uid()::text
  );


-- ============================================================================
-- VERIFY — run these after the above. Both should return exactly one row.
-- ============================================================================
--
--   -- 1. the table policy exists and is a DELETE
--   select policyname, cmd
--   from pg_policies
--   where schemaname = 'public'
--     and tablename  = 'backup_rise_conversations'
--     and cmd = 'DELETE';
--
--   -- 2. the storage policy exists and is a DELETE
--   select policyname, cmd
--   from pg_policies
--   where schemaname = 'storage'
--     and tablename  = 'objects'
--     and policyname = 'own sales-brain db delete';
--
--   -- 3. and the grant landed
--   select privilege_type
--   from information_schema.role_table_grants
--   where table_name = 'backup_rise_conversations'
--     and grantee    = 'authenticated'
--     and privilege_type = 'DELETE';
--
-- THEN, to confirm end to end from the app: Settings -> Backup, switch
-- "Sales Brain memories" off, wait for the next push (up to ten minutes, or
-- press Sync now), and check Storage -> sales-brain -> <your user id>. The
-- folder should be empty. Switch it back on and the next push re-uploads.
-- ============================================================================
