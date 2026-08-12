# M25 Sales Brain — release checklist (auto-update push)

This milestone shipped this app's first-ever embedded database and its
first-ever schema migrations. That makes this release meaningfully riskier
than a normal feature push: a bad migration doesn't just break a feature,
it can corrupt a file every future launch depends on. Treat every step below
as load-bearing, not optional ceremony — this doc exists specifically
because "treat migrations as the highest-risk code in this milestone" was an
explicit requirement going in.

## Before merging

- [ ] `npm run typecheck` clean.
- [ ] `npx vitest run` full suite green — specifically confirm
      `src/main/memory/__tests__/db.test.ts`'s migration-drill tests pass (the
      ones that deliberately break a migration and prove no data loss).
- [ ] `docs/M25-qa-checklist.md` fully run through on a real packaged Windows
      build, not just dev mode.
- [ ] `supabase/2026-08-sales-brain-backup.sql` has been run manually against
      the real (production) Supabase project — bucket + RLS policies exist
      before this ships, or the cloud-backup toggle will silently fail for
      anyone who enables it.
- [ ] Sales Brain (Beta) confirmed OFF by default in a genuinely fresh
      profile — this is the single most important gate on this whole
      release, since it means a broken Sales Brain can ship without breaking
      anyone who hasn't opted in.

## Lessons from actually shipping this (v1.1.9 → v1.1.10)

Two real incidents happened getting this milestone out the door — both fixed, both worth carrying forward:

- **A bad startup-ordering bug shipped in v1.1.9 despite the QA checklist above existing** — because the checklist wasn't run against a profile with the local embeddings model *not yet cached*, which is exactly the condition that triggered it. The checklist now has a dedicated section (0.5) forcing that specific condition. General lesson: when a QA checklist is written before a bug is known, revisit it after every real incident — "we had a checklist" isn't the same as "the checklist covered this."
- **The GitHub Actions release workflow itself failed to publish cleanly twice** (a race between the NSIS and portable Windows targets both trying to create the GitHub release simultaneously) before being fixed with a dedicated "pre-create the release" step. If a future `release.yml` change ever reintroduces multiple Windows publish targets in one electron-builder invocation, check that a release-creation race can't reappear.

## Migration verification (do this literally, don't just re-read the code)

- [ ] Take a real, existing `memory.db` from a profile that was on the
      previous app version (or construct one via the previous version's
      migrations). Launch the NEW build against it and confirm:
  - [ ] It opens without error.
  - [ ] `PRAGMA user_version` (or the app's own visible behavior) reflects
        the new schema version afterward.
  - [ ] All memories that existed before are still present, unchanged.
  - [ ] A pre-migration backup file was created next to `memory.db` during
        the upgrade.
- [ ] Confirm a fresh profile with NO existing `memory.db` still creates one
      correctly at the latest schema version directly (the no-prior-file
      path is a different code branch than the upgrade path — both need
      checking).
- [ ] Confirm launching the OLD app version against a `memory.db` that's
      already on the NEW schema version is refused cleanly (Sales Brain goes
      quiet, doesn't crash, doesn't attempt a downgrade) — relevant if
      auto-update ever rolls out unevenly and someone temporarily has a
      newer DB with an older app.

## DB backup confirmation

- [ ] Confirm the pre-migration backup file actually lands on disk during a
      real upgrade (not just asserted by the unit test) — check the file
      exists, has a sane size, and is a valid SQLite file (openable) before
      considering this verified.
- [ ] Confirm WAL sidecar files (`-wal`/`-shm`) are handled correctly around
      the backup/restore — no stale sidecar left behind after a restore.

## Rollback instructions (if something goes wrong post-push)

If real-world reports show Sales Brain corrupting data or crashing launches
after this update goes out:

1. **First, confirm whether it's isolated to Sales Brain or app-wide.** If
   Sales Brain is OFF for the affected user and the app itself is fine, this
   is contained — the master flag did its job, the fix can wait for a normal
   patch release, no emergency needed.
2. **If Sales Brain being ON is actively breaking the app for those users**
   (crash on launch, stuck migration): the immediate mitigation is a patch
   release that changes nothing about the schema but makes `initSalesBrain()`
   fail soft — if `migrate()` throws, log it and leave the master flag
   effectively inert for that session rather than blocking app startup. This
   is a code change, not a manual per-user recovery step, since there's no
   way to reach an affected user's machine directly.
3. **If a specific user's `memory.db` is actually corrupted** (not just a
   migration bug, but on-disk corruption): their own pre-migration backup
   file (created automatically before the upgrade that caused the problem)
   is the recovery path — talk them through renaming the backup over the
   broken file. This only works if step 2's failure happened *after* the
   backup was taken, which is why the backup-before-migrate ordering matters
   as much as it does.
4. **There is no server-side rollback** — this is a local-first feature with
   no backend to intervene from beyond the Supabase backup bucket (and even
   that's opt-in, off by default). Recovery is always local-file-based.
5. Do NOT ship a rollback that attempts to run migrations backward
   (downgrade). The migration system was deliberately never built to support
   that — attempting it live, under pressure, is far riskier than shipping a
   forward-only fail-soft patch per step 2.

## Post-push monitoring

- [ ] Watch for crash/error reports mentioning `memory.db`, `sqlite-vec`, or
      `better-sqlite3` specifically in the first 24-48 hours after this
      version rolls out — these are the new failure surface this release
      introduces that didn't exist before.
- [ ] Spot-check that Settings → Sales Brain (Beta) is still OFF by default
      for users who update from a pre-M25 version (confirms the setting's
      default merges correctly for existing profiles, not just fresh ones).
- [ ] If usage data/feedback is available, watch adoption of the master flag
      itself — since it's an opt-in beta, near-zero enablement in the first
      few days is expected and not itself a signal of a problem.

## Known, accepted gaps at ship time

- macOS is unverified — flag this explicitly in any release notes or
  internal communication about this milestone, don't let "Mac + Windows"
  read as "both confirmed working."
- Cloud backup for Sales Brain requires the Supabase migration above to be
  run manually — this is not automated as part of any CI/CD in this app.
