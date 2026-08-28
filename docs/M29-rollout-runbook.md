# M29 — Staged rollout runbook

**Who this is for:** the founder, shipping a release to a percentage of users
first and ramping to everyone. Every command here is copy-paste. Nothing in
this document publishes anything by itself — each step is an explicit action
you take.

**Verified against:** `electron-updater` 6.8.9 and `electron-builder` 26.15.3
as installed in the repo (`node_modules`), `.github/workflows/release.yml` at
commit `14969ab`, the live `latest.yml` on release v1.3.2, and this machine's
own `%APPDATA%\sales-os\.updaterId`. Date: 2026-08-23.

---

## 1. How staged rollout works (the whole mechanism in six lines)

1. Every install generates a random UUID once and stores it in
   `%APPDATA%\sales-os\.updaterId` (electron-updater does this by itself; this
   machine already has one). It never changes for the life of the install.
2. The release's `latest.yml` may carry one extra line: `stagingPercentage: 10`.
3. When the app checks for updates it reads that line. It turns the UUID's
   last four bytes into a number between 0 and 1, and if that number is
   **below** `10 / 100`, the update is offered. Otherwise the app reports
   "you're up to date" — exactly as if no release existed.
4. Because the UUID is fixed, the cohort is **stable and monotonic**: an
   install that was "in" at 10% is still in at 25%, 50%, 100%. Ramping never
   drops anyone.
5. No line → 100%. `stagingPercentage: 0` → nobody. A non-number → treated as
   100% (the library logs a warning and lets everyone in) — so **never leave a
   typo in that line; `0` is the halt value, not a blank.**
6. **No app code is involved.** Our own manifest gate (`src/main/updater/
   policy.ts`, `validateUpdate`) reads only `version`, `path`, `sha512` and
   ignores the extra line. The check happens inside
   `autoUpdater.checkForUpdates()` (`electron-updater/out/AppUpdater.js`,
   `isStagingMatch`, called from `isUpdateAvailable`), which is what
   `src/main/updater/index.ts` calls.

Evidence trail: `node_modules/electron-updater/out/AppUpdater.js:314-332`
(the percentage test), `:501-527` (the UUID file), `:351-354` (the gate inside
`isUpdateAvailable`); `node_modules/builder-util-runtime/out/updateInfo.d.ts:60`
(`stagingPercentage?: number` is a typed, documented field);
`node_modules/electron-updater/out/providers/GitHubProvider.js:110-135`
(the manifest is fetched from `releases/download/<tag>/latest.yml` of whatever
`/releases/latest` returns — drafts and prereleases are invisible to it).

### What a user outside the cohort sees

Nothing. Settings → "Check for updates" says they are up to date. This is
correct and intended, but remember it when someone says "I don't see 1.4.0."

### What halting does and does not do

Setting `stagingPercentage: 0` stops **new** installs from being offered the
version. It does **not** roll back anyone who already updated — the app has
`allowDowngrade = false` (deliberately; a downgrade is the move an attacker
makes). To fix users already on a bad version you ship a **newer** patch
version at 100%.

---

## 2. The flow that works TODAY (no code changes)

Use this until the CI change in §3 is built and verified.

**Historical note:** this section was written when `release.yml` published at
100 % with a patch-it-after window. Since `220c00a` (2026-08-24) §3's flow
runs instead — releases are born drafts and ship staged at 10 % by default —
so Step 1–2 below are superseded. **Steps 3–6 remain the live procedure for
verifying, watching, ramping and halting any release.**

### Step 1 — publish as you do now

```bash
# in the repo root, on main, with package.json already bumped to e.g. 1.4.0
git tag v1.4.0
git push origin v1.4.0
```

Wait for the "Publish a real release" workflow to finish (GitHub → Actions).
Confirm the release exists and has four assets:

```bash
gh release view v1.4.0 --repo nirtsur1998-bot/callrise-ai --json assets --jq '.assets[].name'
```

Expected: `CallRise-AI-Windows.exe`, `CallRise-AI-Windows.exe.blockmap`,
`CallRise-AI-Windows-Portable.exe`, `latest.yml`.

### Step 2 — set the rollout percentage (do this immediately after Step 1)

```bash
cd "$TEMP" && rm -f latest.yml && gh release download v1.4.0 --repo nirtsur1998-bot/callrise-ai -p latest.yml && printf '\nstagingPercentage: 10\n' >> latest.yml && cat latest.yml
```

Check the printed file: the original `version`, `files`, `path`, `sha512`,
`releaseDate` lines must be **untouched**, with your new line at the bottom.
Then upload it over the old one:

```bash
cd "$TEMP" && gh release upload v1.4.0 latest.yml --clobber --repo nirtsur1998-bot/callrise-ai
```

### Step 3 — verify the live manifest says what you think

```bash
curl -sL "https://github.com/nirtsur1998-bot/callrise-ai/releases/download/v1.4.0/latest.yml"
```

GitHub's CDN can serve the previous copy for a few minutes after a clobber. If
you see the old file, wait five minutes and run it again before trusting it.

### Step 4 — watch

Until the M29 telemetry (Workstream A1/A2) exists, the only signals are:

```bash
# how many installs have taken the new version (the .exe download count)
gh release view v1.4.0 --repo nirtsur1998-bot/callrise-ai --json assets --jq '.assets[] | "\(.name)\t\(.downloadCount)"'
```

…and whether anyone emails you. Once A1/A2 ship, this step becomes "open the
version-health query in Supabase and compare crash-free rate for 1.4.0 vs the
previous version" — that query will be added to this document when it exists.

**Minimum watch before ramping:** 48 hours at 10%, then 48 hours at 50%. With
the current install base (18 update checks in the first five days of v1.3.2,
one installer download), a 10% cohort may be zero people. If the `.exe`
download count is still 0 after 48 hours, ramp anyway — you have learned
nothing and waiting longer will not change that.

### Step 5 — ramp

Repeat Step 2 with a larger number. Suggested ladder: `10` → `50` → `100`.
Ramping to 100 is the same as deleting the line.

### Step 6 — halt (if you see a problem)

```bash
cd "$TEMP" && rm -f latest.yml && gh release download v1.4.0 --repo nirtsur1998-bot/callrise-ai -p latest.yml && sed -i 's/^stagingPercentage:.*$/stagingPercentage: 0/' latest.yml && grep -n stagingPercentage latest.yml && gh release upload v1.4.0 latest.yml --clobber --repo nirtsur1998-bot/callrise-ai
```

Then fix the bug, bump to the next patch version, and publish **that** at a
percentage again. Do not delete the halted release — the fixed version must be
strictly newer than it, and deleting it would re-expose the previous version
as "latest" to people who already took the bad one.

---

## 3. The flow that runs NOW (zero window) — BUILT AND LIVE-VERIFIED 2026-08-24

Merged to `main` as `feat/staged-rollout-ci` (`4c931ec`, merge `220c00a`).
From the next tag onward, `release.yml` does all of this by itself:

1. The GitHub release is created as a **draft** — invisible to
   `/releases/latest`, the Atom feed, and therefore every updater.
2. electron-builder uploads every asset into the draft (its publisher reuses
   an existing draft with a matching tag regardless of `releaseType`).
3. A final step validates the rollout percentage (an integer 0–100 —
   electron-updater treats a NaN as 100 % with only a warning, so a typo
   dies in CI instead), appends `stagingPercentage` to `dist/latest.yml`
   when it is under 100, `--clobber`s it onto the draft, and **re-downloads
   the asset to prove the staged manifest is the one actually there**.
4. Only then does the draft flip live. **Tag pushes default to 10 %.**
   `workflow_dispatch` takes a `rollout_percent` input. A semver-prerelease
   tag (`v1.4.0-test.1`, `v1.4.0-beta.2`) flips to a GitHub **prerelease**
   instead — the test channel: visible on the releases page, invisible to
   the shipped updater.

Failure anywhere leaves a draft: the failure mode is "nothing shipped,"
never a torn or 100 %-exposed release. §2's Steps 3–6 (verify, watch, ramp,
halt) are unchanged — ramping is still the one-asset `latest.yml` edit.

**Live verification (the milestone's bar: a real publish to a test channel
before it is trusted).** Throwaway dispatch on `test/rollout-ci-probe`,
version `1.3.4-test.1`, `rollout_percent=7` (an odd number so the check
could not accidentally match a default), run `32681149728`, completed
success 2026-08-24 ~02:04 UTC:

| Claim | Evidence read back from the live repo |
|---|---|
| Born a draft, assets filled while invisible, flipped last | final state `draft: false, prerelease: true, assets: 4`; the flip is the job's last step |
| The staged manifest is the one on the release | `releases/download/v1.3.4-test.1/latest.yml` fetched over the public CDN ended `stagingPercentage: 7` with `version: 1.3.4-test.1` and an intact sha512 |
| Invisible to updaters throughout | `/releases/latest` resolved to `v1.3.3` before, during, and after |
| The client-side cohort math is real | this machine's actual `.updaterId` (`e8328791-…`) hashes to cohort **35.79 %** via electron-updater's own `UUID.parse(id).readUInt32BE(12)/0xffffffff` — OUT at 7 % and 10 %, IN from 37 %, deterministic and monotonic |
| No residue | test release, tag `v1.3.4-test.1`, and branch deleted; releases list = v1.3.3, v1.3.2, v1.3.1 |

**What the founder does per release now:** bump `package.json`, push the tag
(ships at 10 % automatically), watch per §2 Step 4, ramp per §2 Step 5.
To ship at a different percentage: GitHub → Actions → "Publish a real
release" → Run workflow → set `rollout_percent` (100 = everyone at once).

## 4. Things that will bite

- **`x-user-staging-id` header.** electron-updater sends the `.updaterId` UUID
  to GitHub on every update check (`AppUpdater.js:386-387`). It is not tied to
  any account and GitHub is not our server, but "your data stays on your
  machine" copy must not claim the app makes no identifiable requests at all.
  This pre-dates M29 and is disclosed in the M29 audit.
- **Don't hand-edit `sha512`, `size`, `path`, `url`.** Any change there makes
  every download fail the integrity check ("refused" in the updater status).
- **Auto-update is OFF by default** (`src/main/app-settings.ts:742`,
  `autoUpdateEnabled: false`). An install only checks for updates when the
  user clicks "Check for updates" in Settings, or has switched auto-update on
  (then: 30 s after launch and every 6 h). So a bad version cannot be *pushed*
  out by publishing a fixed one — the people on it have to come looking.
  Treat the §2 Step 4 download count as "people who looked," not "people who
  have it."
- **Portable builds are not an auto-update target.** electron-updater's Windows
  path is built around the NSIS install; nothing in `src/main/updater/` guards
  the portable case. Treat portable users as always outside any cohort, and
  tell them to download manually.
- **Two releases, same tag.** Never re-run the workflow for a tag whose release
  is already public and older than two hours — electron-builder refuses to
  attach assets to it (`gitHubPublisher.js:85-95`) and the run fails late.
