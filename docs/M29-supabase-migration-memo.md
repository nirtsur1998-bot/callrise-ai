# Decision memo — the Supabase migration (new account, founder-initiated)

**Status:** DECISION MEMO. The founder decides the option and the timing;
nothing here is executed. **Date:** 2026-08-24.

**The standing rule this memo exists to enforce (founder, same day):** the
new project gets provisioned **COMPLETELY on day one from all four SQL
files**, per taxonomy species 23. The migration is the cure for
shipped-as-code-but-never-deployed precisely because it starts from zero
with a checklist — if it becomes incremental again under time pressure, it
stops being the cure and becomes the fourth patch. The sequence below bakes
the completeness check in as a *probe*, not a memory.

---

## What the current project holds (audit §2 + §9, probed live)

| Asset | State | Does it need to move? |
|---|---|---|
| `auth.users` accounts | unknown count — **founder: read it in Dashboard → Authentication → Users.** Estimate: ≤5 real accounts (v1.3.2's manifest saw 18 downloads over 5 days, mostly this machine's own checks; the installer saw 1) | The only asset that cannot be rebuilt from users' machines |
| 8 `backup_*` table rows | live | No — every row is a mirror of local-first data that re-pushes itself |
| `attachments` bucket objects | live | No — pushed from local blobs (`attachmentBlobPath`), re-uploads on sync |
| `sales-brain` bucket | **never existed** (BUG-087) | Nothing to move; the new project finally gets it |
| `server_now()`, repair column, alerts backend, telemetry table | never deployed | Nothing to move; the new project gets them on day one |

The deep fact that makes this migration cheap: **the cloud is a mirror, not
a source.** Local files are the truth; `backup.ts` pushes from local truth
on every sync. An empty new project fills itself from each machine's next
sync. The only genuinely server-side asset is the account list.

## Option A — fresh start (recommended, with one confirmation)

New project, provisioned day one, ships in a release; **users create their
accounts again** (same email is fine — it's a new user table).

**What a user experiences at cutover, moment by moment:**
1. They update to the cutover release (staged, like any release now).
2. On launch, their stored session token belongs to the old project → the
   refresh fails → the app shows the **sign-in screen**. Verified in code:
   this path does NOT wipe anything — `clearAllAiKeys` runs only inside the
   explicit Sign-out button (`auth.ts:426`). **Keys, calls, tasks, contacts,
   memories: all intact.**
3. "Log in" fails ("no account") — they tap **"New here? Create an
   account"**, use the same email, confirm the code.
4. First sync re-uploads everything from local truth — including, for the
   first time ever, `memory.db` into the now-existing `sales-brain` bucket.
5. Done. Total user cost: one re-registration and one email code.

**The two UX conditions that make A honest:**
- The cutover release carries a one-time notice (same pattern as the
  auto-update card): *"We've moved our sign-in service. Your data is on your
  machine and is not affected — please create your account again with the
  same email."* Without it, "log in failed" reads as data loss to a
  stranger, which it is not.
- The notice explicitly says **don't press Sign out** — that button (and
  only that button) wipes stored API keys.

**What A loses:** any cloud-only copy belonging to a machine that died
before cutover (none known); cross-device restore continuity for the gap
(multi-device users re-seed from whichever machine syncs first — the
reconciler merges by timestamp, so nothing is lost when both sync).

## Option B — migrate accounts and data

- **Accounts:** password hashes can't be exported by us; moving them means a
  Supabase support request or forcing password resets anyway — at which
  point the user does roughly the same work as re-registering.
- **Tables/buckets:** pg_dump/restore + object download/upload. Hours of
  fiddly, service-role work — to move mirrors of data that re-uploads
  itself.
- Worth it only if the account list is large or accounts carry value beyond
  the email (they don't: no roles, no profiles — audit §5).

**Recommendation: A**, *conditioned on the founder reading the real user
count first.* If Dashboard → Users shows what the install base implies
(≤~10, mostly yours), fresh start is genuinely cleaner. If it shows
something surprising, stop and revisit.

## The exact sequence (each step verified before the next)

1. **Founder:** create the new project. Note URL + anon key + region.
2. **Founder:** SQL editor → run, in order: `backup-schema.sql` →
   `2026-07-deals-and-scrub.sql` → `2026-08-sales-brain-backup.sql` →
   `2026-08-telemetry.sql` → `2026-08-entitlements.sql`. (NOT
   `alerts-schema.sql` — that waits for the alerts deploy decision; the
   section is hidden.) Every file is idempotent; the telemetry file stamps
   `schema_versions`. The entitlements table is provisioned now so B2 needs
   no later schema step; it grants nobody anything until billing ships (B4)
   and the enforcement constant flips — see `docs/M29-B2-entitlements-memo.md`.
3. **Session (me):** probe the new project anonymously — same probes as the
   audit: 8 tables answer 200, `server_now()` returns a timestamp,
   `clock_skew_repaired` selects, both buckets answer "Object not found"
   (exists) not "Bucket not found", telemetry table rejects a malformed
   insert and accepts a valid one. **Species 23's check: "provisioned" is a
   probe result, not a memory.** A one-line row in `schema_versions` per
   file is the receipt.
4. **Session:** `default-config.ts` gets the new URL + anon key; **BUG-088
   fix lands in the same release** (the WAL-blind memory.db upload — see the
   stopgap doc; the new bucket must not be trusted with stale uploads); the
   one-time cutover notice card; full suite; commit.
5. **Founder:** take a fresh manual Sales Brain backup (stopgap doc), check the GO gate in `docs/M29-cutover-runbook.md`, then
   tag the cutover release. It ships staged at 10 % like everything now;
   given the notice is the whole point, ramping to 100 % quickly is fine.
6. **Verify on this machine AND the restore path (founder's addition):**
   update → re-register → Sync now → new project's Dashboard shows the
   backup rows AND `sales-brain/<uid>/memory.db` with a **fresh** timestamp
   AND (after Diagnostics → Send now) a telemetry row. Then, on the clean
   VM / a second profile: install → sign in → first sync pulls the cloud
   memory.db → Memory Center shows the memories — with stale sidecars
   planted first, so BUG-089's fix is exercised against its actual trigger.
   A cutover that only verifies uploads leaves the restore path exactly as
   unexercised as the activation audit found it. Full procedure, gates and
   failure table: `docs/M29-cutover-runbook.md`.
7. **Parachute:** old project untouched for 30 days (paused, not deleted),
   then delete. Calendar reminder, not memory.
8. Update `docs/`/vault: BUG-084/087 closed by provisioning, verified by
   step 3's probes.

## Timing

No forcing function says "now" except BUG-087's standing exposure (no
memory.db cloud copy) — which the manual stopgap covers as of today. Sensible
slot: after A5 lands (so BUG-088's fix and the export button ride the same
release), before B3 (so the clean-machine onboarding walk exercises the NEW
project's sign-up path, not the doomed one — testing onboarding against a
project about to be deleted would be testing the wrong thing).

## Decisions

| # | Question | Lean |
|---|---|---|
| 1 | A (fresh start) vs B (migrate) | **A**, after reading the real user count |
| 2 | Cutover slot | after A5, before B3 (so the clean-machine walk tests the new project) |
| 3 | Old-project parachute | 30 days paused, then delete |
| 4 | BUG-088 + export button in the cutover release | yes — the new bucket must start with trustworthy uploads |
