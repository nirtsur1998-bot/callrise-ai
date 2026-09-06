# M35 + M36 — the release proposal

**Prepared 2026-09-06, night. Version and rollout are the founder's; nothing is tagged or
published.** Both branches are merged to `main` (`022455d` M35, `edc65da` M36) and pushed. `main`'s
tree is byte-identical to the M36 tip (`git diff` empty); the verify-green gate on `main`'s own
checkout, after `npm ci` from `main`'s lockfile: **GREEN, 378 files, 3662 tests** (`gate exit=0`).
CI on `main` (Verify, windows-latest) is recorded in the chat with its run id.

## What has piled up since v1.10.0 (`a85ce9a`, 2026-09-05)

56 commits plus the two merges. What a user would notice:

- **The first minutes** — a splash from app-ready until the window paints (BUG-191, 35 s of nothing
  before); a truthful mic list and one vocabulary for a failed mic request (BUG-190); the release
  page tells a stranger which file to take and what the SmartScreen block looks like (BUG-192);
  **the sample call before any account** — "See a sample call first" on the sign-in screen,
  rendered read-only, stored nowhere, one click to sign up.
- **The Live screen** — the glance HUD (one line, the state strip with the deal facts folded in,
  the transcript on by default and collapsible), behind the M31 design preview which is on by
  default. **This has not been on a real call yet** (the founder's observation is owed; protocol in
  `docs/M36-hud-observation-protocol.md`). The React #310 crash on the first mic press is fixed
  and gated (BUG-194).
- **The Sales Brain** — the lexical channel (FTS5 + fusion; migration 5); temporal validity (every
  memory carries a window; migration 6 and a one-time measured backfill; the Memory Center shows
  windows and superseded facts; Rise answers "as of" questions from the words typed and refuses
  earlier than its earliest fact); usage-aware decay; option B on (an unbound Rise chat searches the
  clients the question names); **BUG-196 shape (b)** — client facts the guardrail used to drop are
  kept in the client's own scope.
- **Calendar and saving** — a calendar push that fails is seen and retryable (BUG-169); a saved
  call's journal is retired at save (BUG-189a/c); the objection queue joins the backup (BUG-189b);
  events whose calendar no longer exists become local-only with the reason recorded.
- **Copy and chrome** — one tooltip primitive; the Voice AI rail folds itself below 1120 px
  (BUG-171); Gemini's "no prepaid credit" reason is passed through instead of "rate-limited"
  (BUG-197 part 1); the founder's name is out of every fixture.
- **Safety** — a dev build on a profile copy refuses cloud sync (BUG-186); the diagnostics bundle
  carries a device classification, never a label (BUG-122); scripts/ no longer ships in the package
  (BUG-124).

## Version: **1.11.0**

A minor bump, not a patch. Two migrations run on every user's `memory.db` on first launch (5 and 6),
the Live screen changes for everyone with the design preview on, and the sign-in screen gains a
door. `1.10.1` would tell people nothing changed for them.

## Rollout: **the 10 % staged default**, then the runbook ramp

The reason to stage: migration 6's backfill writes every memory row once, and the HUD has not been
on a call. Ten percent of installs is the founder's own machines plus a handful; the ramp
(`docs/M29-rollout-runbook.md`) is one asset edit after a day with no red run.

## Before the tag — what was driven, and the one gap

| Change | Driven where |
|---|---|
| M35 (BUG-169/171/186/189, tooltips, orphans) | the founder's real profile, dev app; M35's last 5 % on the clean VM (`vm-*` screenshots, 63 s live transcript) |
| Splash, mic list, sample-call door, BUG-194 fix | the clean VM, packaged installer built at `a7c8589` |
| Temporal validity, Memory Center windows, Rise as-of | the founder's real store on the host dev app (73 facts: 70 real dates, 3 approximate; `host-13/14`) |
| Lexical channel, option B, decay | harness measurements only; not driven as UI (they have no UI) |
| BUG-196 shape (b), instrument | offline replay over 32 real refused proposals; live runs indicative only (BUG-195) |
| **The purity refactor in `d9d524d`** (StateStrip, GlanceLine, useGlanceCue, MemoryCenterSection) | **render tests only. Not driven.** It landed after the last VM walk and after the host drive. |

The gap is the last row: the four files it touched are the HUD and the Memory Center, both on the
release's user-visible path. **Recommendation: one packaged-build walk on the VM before the tag** —
sign in with the test account (the VM is signed out), open Live and press the mic, open Settings →
Review what it remembers — roughly ten minutes with the RDP driver, no new build needed beyond
`npm run build:win` from `main`. I can run it the moment the VM account is logged in.

## The five checks — to run AFTER publishing

From `docs/release-feed-verification.md`, with the tag filled in.

```bash
gh release view v1.11.0 --json isDraft,isPrerelease,publishedAt
```
1. Live, not a draft or prerelease.

```bash
git fetch origin --tags && git rev-parse v1.11.0^{commit} HEAD origin/main
```
2. The tag names the commit that shipped: all three hashes identical.

```bash
gh release download v1.11.0 --pattern latest.yml --dir /tmp/feed && cat /tmp/feed/latest.yml
```
3. `latest.yml` names `1.11.0`, the installer's sha512 matches the asset, and `stagingPercentage`
   is the number the founder chose.

```bash
gh run list --workflow "Built vs shipped" --limit 1
```
4. The unshipped report's part A ("merged into main, not released") goes green on its next run.
   Its part B stays red and this release does not clear it: five branches carry unmerged work,
   the oldest 12 days (`claude/overnight-audit`); M35 and M36 merging takes two off that list, the
   rest are the founder's held branches.

5. An install on the VM from the release page updates itself to 1.11.0 (or reports "up to date" if
   its cohort is outside the staged percentage — say which).

## What this release does not contain

Shape (c) (client categories, design in `docs/M36-bug196-shape-c-design.md`), the re-extraction of
the founder's store, and BUG-197 part 2 (re-verifying Google model ids against the live list).
Step 4's parser is in the build, wired, and stays behind the extraction work in priority, not in
shipping: it only speaks when a question carries a date.
