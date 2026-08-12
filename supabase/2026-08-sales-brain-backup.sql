-- M25 Sales Brain — cloud backup for the local memory.db file.
--
-- Deliberately a WHOLE-FILE BLOB, not row-per-record like every other
-- category in backup-schema.sql (backup_tasks, backup_calls, etc.) — this
-- is the same pattern already used for attachment blobs (private Storage
-- bucket, one object per user, path "<user_id>/<...>", RLS scoped by the
-- first path segment). memory.db is single-machine-scoped today (Sales
-- Brain has no multi-device merge story yet), so a full-file overwrite on
-- every push is correct and far simpler than teaching Supabase to
-- understand SQLite's internal row structure.
--
-- KNOWN UPGRADE PATH, if multi-device support is ever built: switch this to
-- row-level sync (a `backup_memories` table, id-keyed, mirroring
-- backup_contacts/backup_calls' shape) the same way every other category
-- here already works, WITH real per-record conflict resolution — a blob
-- overwrite has none. This file/decision is the marker for that future
-- work, not an oversight; see docs/M25-sales-brain.md for the full
-- reasoning.
insert into storage.buckets (id, name, public)
values ('sales-brain', 'sales-brain', false)
on conflict (id) do nothing;

drop policy if exists "own sales-brain db select" on storage.objects;
create policy "own sales-brain db select" on storage.objects
  for select using (
    bucket_id = 'sales-brain' and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "own sales-brain db insert" on storage.objects;
create policy "own sales-brain db insert" on storage.objects
  for insert with check (
    bucket_id = 'sales-brain' and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "own sales-brain db update" on storage.objects;
create policy "own sales-brain db update" on storage.objects
  for update using (
    bucket_id = 'sales-brain' and (storage.foldername(name))[1] = auth.uid()::text
  );
