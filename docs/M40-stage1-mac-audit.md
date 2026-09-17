# M40 Stage 1 — the Mac audit: what's Windows-only, and what actually happens when you run it

**Written:** 2026-09-17, on the Mac, against `a8bfc35` (1.13.0) after fast-forwarding this
checkout 841 commits.

Companion to [`virtual-mic.md`](virtual-mic.md) (Stage 0). This one answers: *does 1.13.0 run on
a Mac, and what did months of Windows-only development assume?*

**Headline: it runs, and it runs better than expected.** The codebase is far more cross-platform
than the brief anticipated — three files carry a `win32` branch with no `darwin` path, and all
three are correct. The real Mac problems are in **getting it to start**, not in the app.

---

## Severity key

| | meaning |
|---|---|
| **BLOCKS** | a fresh Mac cannot run the app at all until this is worked around |
| **FEATURE** | the app runs; something specific does not work |
| **SILENT** | nothing visibly breaks, but the code is wrong or unverified in a way that will bite |

---

## BLOCKS — a fresh Mac checkout cannot start the app

### 1. `npm install` does not install Electron, and the error blames the wrong thing

This is the one that costs a new machine an hour.

npm 11 gates lifecycle scripts. `npm install` completes with **exit 0** and prints, among ordinary
noise:

```
npm warn allow-scripts   electron@39.8.10 (postinstall: node install.js)
npm warn allow-scripts   Run `npm approve-scripts --allow-scripts-pending` to review
```

So Electron's binary is never downloaded. The app then dies at launch with:

```
Error: Electron failed to install correctly, please delete node_modules/electron and try installing again
```

which points at a corrupt install rather than at a blocked postinstall. `node_modules/electron/`
looks populated — `dist/` even exists — but holds only a stray `LICENSES.chromium.html`, and
`path.txt` is missing. That is the actual tell:

```bash
ls node_modules/electron/path.txt        # missing  -> postinstall never ran
cat node_modules/electron/dist/version   # missing  -> nothing was extracted
```

**`electron-builder install-app-deps` is blocked by the same gate**, so `better-sqlite3`,
`active-win` and `sharp` are left built for system Node rather than Electron's ABI — the silent
never-loads failure CLAUDE.md already warns about for the detection addons.

**Workaround used here** (the zip was already cached, and is the correct version):

```bash
unzip -q -o ~/Library/Caches/electron/<hash>/electron-v39.8.10-darwin-arm64.zip \
  -d node_modules/electron/dist
# then write node_modules/electron/path.txt containing exactly, with NO trailing newline:
#   Electron.app/Contents/MacOS/Electron
npx electron-builder install-app-deps
```

The no-trailing-newline detail matters: `electron/index.js` uses the file's contents verbatim as a
path component, so a stray `\n` yields a path that does not exist. Verified: 36 bytes, and
`require('electron')` resolves to a path that exists.

After that, `electron-builder install-app-deps` rebuilt `active-win`, `better-sqlite3` and `sharp`
against `electronVersion=39.8.10 arch=arm64`.

**Unresolved, and worth knowing:** running `node node_modules/electron/install.js` **directly**
also exits 0 and does nothing — no output, no extraction, no `path.txt`. It is not the
`ELECTRON_SKIP_BINARY_DOWNLOAD` early-exit (unset), `isInstalled()` correctly returns false, and
both `@electron/get` and `extract-zip` require cleanly. **Cause not determined.** The manual
extract above sidesteps it.

*Not established:* whether `npm approve-scripts` fixes this cleanly, and whether the Windows
machine hits the same gate (it is an npm-version behaviour, not a platform one — so probably yes,
and its `node_modules` may simply predate npm 11).

---

## SILENT — wrong-shaped code that happens not to fire on Mac

### 2. `tier1.ts` is Windows-shaped and has no platform gate

`registerTier1()` is called **unconditionally** from `index.ts:823`, directly under a comment that
says Tier 1 is *"driver-free noise cancellation … **(Windows)**"*. The code knows; the call site
does not check.

On Mac, `tier1.ts:110` computes:

```js
join(process.env['LOCALAPPDATA'] ?? '', 'CallRiseAI', 'kern_bridge_status.json')
// LOCALAPPDATA is undefined on macOS, so this is "CallRiseAI/kern_bridge_status.json"
// — a RELATIVE path, resolved against the process cwd.
```

**It is nevertheless inert, and I want to be precise about why, because my first read overstated
this as a live defect:**

- `registerTier1()` only registers IPC handlers — it does not spawn or write at startup.
- `resolveEnginePath()` looks for `kern_bridge.exe`, finds nothing on Mac, returns `null`.
- `resolveDenoisingActive()` opens with `if (!child?.pid) return null` — so the bad path is
  **never actually read**, because reading it requires a running engine child that cannot exist.
- The renderer's `Tier1SettingsCard.tsx` **is** platform-gated (5 platform refs; 13 in its test).

So: safe today, by defensive coding rather than by design. It is one refactor away from being a
real bug — anything that makes `readEngineStatus()` reachable without a child, or that adds a
write, starts creating `CallRiseAI/` wherever the app's cwd happens to be (`/` for a packaged
app).

**Recommended, not done:** gate `registerTier1()` / `registerTier1Diagnostics()` on
`process.platform === 'win32'`, so the guarantee is structural instead of incidental.

### 3. `tier1-diagnostics.ts` spawns `powershell.exe`

Line 123. Same situation — unreachable on Mac in practice, unguarded in principle.

### 4. One PowerShell script with no Mac equivalent

`scripts/verification/collect-bugd-evidence.ps1` — the only `.ps1` in the repo. Evidence
collection for one bug; not load-bearing.

---

## Audited and CLEAN — things the brief expected to be broken

| checked | result |
|---|---|
| `win32` branches with no `darwin` path | **only 3 files**, all correct (below) |
| `%APPDATA%` / `C:\` / hardcoded backslashes | none outside `tier1*` and telemetry **scrubbing** patterns (which must match Windows paths — that is their job) |
| `safeStorage` | used by `auth`, `ai-keys`, `google`, `outlook`, `voice-note`; `safeStorage` is Keychain-backed on macOS and the app has Mac-specific tests (`bug250-unreadable-key-is-not-a-missing-key`). No DPAPI assumption found. |
| custom title bar | no Mac-specific breakage observed on any screen |
| Mac buyer capture | **implemented** — `loopback.ts:181` gates on `darwin \|\| win32` |
| native addon build | `native:build:mac` succeeds, targets node-gyp **39.8.10** (Electron's ABI, not system Node) |
| typecheck + bundle | `npm run build` succeeds; **0** `error TS` |

The three `win32`-without-`darwin` files, each correct:

- **`atomic-write.ts`** — skips a directory-fsync on Windows because Windows cannot open a
  directory as a file handle. macOS takes the *stronger* path. Correct, and Mac-favourable.
- **`detection/adapters/WindowsAdapter.ts`** — has a `MacAdapter` sibling. Correct by design.
- **`preload/index.ts`** — exposes `process.platform` for CSS decisions. Correct.

---

## Ran it — 24 screens, both themes

Launched against a **sandbox profile**, never the founder's real data:

```
[dev] userData overridden -> …/scratchpad/sandbox-profile
[dev] SANDBOX profile at …: cloud backup push and pull REFUSED
[dev] SANDBOX egress gate ON — refused: sync, calendar, transcription, ai, alerts, models
```

**Zero startup errors.** Sign-in works on macOS (confirmed by the founder logging in).

Identity was pinned per the README's species-110 rule, and the first answer was a false alarm worth
recording: the port was held by PID 28022 while I had spawned 28001. Rather than dismiss it, I
walked the parent chain — `28022 ← 28021 ← 28001` — `npx` double-wraps. Same launch. **My check was
too strict, not the app wrong.**

### `screen-sweep.mjs` — 0 defects, 0 console errors

```
red check — console hook sees a planted error: OK
red check — text probe: 5/5 planted caught, 0 false positives, cleaned up: OK

states visited : 24  (skipped 3, each with its reason)
visible defects: 0
console errors : 0
```

Earned zeros — the instrument proved it could fire before reporting. The 3 skips are honest: two
call-detail pages (**0 rows in the sandbox**) and "Background jobs" (matched 0).

### Theme — light and dark both correct

Asserted on the **rendered colour**, not the class, and on **change**, not on a match:

```
Light  bg rgb(13, 12, 10)    -> rgb(255, 254, 252)   changed=true  sha=505a137a4e30f674
Dark   bg rgb(255, 254, 252) -> rgb(13, 12, 10)      changed=true  sha=ea45406664849e66
PASS: colour moved both ways; screenshot hashes differ
```

`changed=true` in **both** directions, so neither leg passed by already being in the target state —
the failure mode the README records as having produced "two byte-identical dark screenshots reported
as a two-theme pass". Screenshots confirmed by eye.

### `occlusion-sweep.mjs` — 1 hit, and it is the documented non-defect

At 900px on Library, empty-state text sits under an `<svg>`. Read rather than counted: its parent is
`aria-label="Jump to the bottom"` — the chevron the README **names as the deliberate example**:

> *"A floating affordance that deliberately sits over content — the jump-to-bottom chevron is the
> example… Read the hits; do not treat a non-zero count as a defect count."*

Clean at 1280px and 1100px. **Not a defect, and not Mac-specific.**

---

## `verify-green.mjs`: NOT GREEN — but not Mac-specific

> **Resolved 2026-09-18, and the guess below was right for the wrong reason.** It was not
> BUG-141's concurrency shape — it was the **Node version**: this Mac runs Node 26, CI pins 22, and
> Node ≥ 25's own `localStorage` global shadows happy-dom's. Under Node 22 the full suite is
> **468 files / 4517 tests passed, exit 0** on this Mac. Full account in
> [`M40-known-issues.md`](M40-known-issues.md) §4 and the verification README.

```
VERDICT: NOT GREEN     (0 typecheck errors; ~14 main-process test FILES failing)
```

`calls-fs.app-version.test.ts` — one of the failures — **passes 14/14 when run alone**. That is
BUG-141's documented shape: failures that appear only under the full concurrent suite, which the
repo already has an instrument suite for (`bug141-load.mjs`, `bug141-analyze.mjs`).

**I did not diagnose this**, and I cannot say whether the Windows machine is green on the same
commit. Given 1.13.0 was tagged, presumably it is — which would make this Mac-specific
*concurrency* behaviour rather than a Mac code defect. **Unestablished either way.**

---

## What I did NOT verify

Worth reading before trusting any of the above as "Mac parity is done".

- **The sandbox has no data.** No calls, contacts or deals — so every data-heavy screen rendered its
  empty state. Call-detail pages were skipped for exactly this reason. *A clean sweep over empty
  screens is a much weaker claim than a clean sweep over populated ones.*
- **Nothing that needs the network ran.** The sandbox egress gate refuses sync, calendar,
  transcription, ai, alerts and models. So: no live transcription, no dual-channel capture, no
  Google/Outlook sync, no Supabase backup, no AI features were exercised. Stage 4 work, untouched.
- **No `.env`** on this machine, so AI/auth config paths are unexercised beyond sign-in.
- **Auto-update not examined.** ~~no `latest-mac.yml`~~, ~~`publish.url:
  https://example.com/auto-updates` — a placeholder~~ — **BOTH CORRECTED, see below.** Now audited
  properly in [`M40-stage3-mac-release-audit.md`](M40-stage3-mac-release-audit.md).
- **Packaged build never produced.** Everything above is the dev build. **Superseded** — a real
  `--mac dmg zip` package was built for the Stage 3 audit. The detection addon's asar-unpacked path
  is still untested, and nothing was signed or notarized.

> ### The stale checkout had a second cost nobody predicted: obeying the wrong rules
>
> The `CLAUDE.md` in the 0.1.0 tree said *"work in the main folder and commit directly to
> `main`."* The real one — superseded at M26/M27 — says main is never edited directly. The session
> inherited the stale rule from a checkout **841 commits behind and followed it faithfully for 12
> commits**, and nothing in the session would have surfaced it: the file was read once, at start,
> before the fast-forward replaced it.
>
> **Not just auditing the wrong code: obeying the wrong rules.** A `CLAUDE.md` is the one file where
> being 841 commits behind means following superseded policy with full confidence. The commits were
> moved onto `claude/m40-mac-parity` non-destructively (verified: `main == origin/main`, all 12
> present with the same SHAs, branch tree byte-identical to the old main's).
>
> **First-step rule, for every session: check the checkout's position (`git fetch && git rev-list
> --left-right --count main...origin/main`) BEFORE reading its instructions, not after.**

> ### CORRECTION — two claims above were read off the stale 0.1.0 tree
>
> Both were written before this checkout was fast-forwarded, and both are wrong on 1.14.0:
>
> - **"no `latest-mac.yml`"** — wrong. It **is** produced, even with dmg-only targets.
> - **"`publish.url: https://example.com/auto-updates` — a placeholder"** — wrong. `publish:` is a
>   real GitHub provider config with `releaseType: release`, carrying a long comment about v1.0.0
>   having shipped as a silent draft.
>
> The underlying *concern* survives and turned out to be real, for a different reason: `target:
> [dmg]` alone does break macOS auto-update, because `MacUpdater.js` requires a **zip** and
> explicitly excludes `dmg`. That is confirmed from the installed updater's source and the fix is
> verified. But the two statements above were not evidence for it — they were stale readings that
> happened to point at a real problem, which is not the same thing.
- **Whether the npm-11 script gate also affects the Windows machine.** It is an npm behaviour, not a
  platform one, so it probably does — but that is reasoning, not a measurement.

---

## Instrument failures this session — six, and they are the honest part

Recorded in full in [`scripts/verification/README.md`](../scripts/verification/README.md) under
*"AUDIO INSTRUMENTS"*. Listed here because Stage 1's conclusions depend on which readings survived:

1. An `awk` range expression that printed a false zero for **every** audio device.
2. `log` is a **zsh builtin** shadowing `/usr/bin/log` — the failure read as "no log entries".
3. Feeding **speech** to `capturetest`, whose threshold is calibrated for a 440 Hz sine.
4. A "discontinuity" finding built on **one non-reproducible** measurement (retracted).
5. `echo "exit: $?"` **after a pipe** — read `tail`'s exit code, not the command's. Species 69,
   from a README section I had read an hour earlier.
6. `| tail -45` on `verify-green.mjs`, which **discarded the failure reasons** I then went looking
   for. The README has a section titled *"Your own `| tail -N` can hide half the problem."*

The pattern in 5 and 6 is worth naming: **both are failures I had read about, in this repo's own
file, and committed anyway.** Reading the rules is not the same as running them, and the gap
between the two is where six wrong readings came from in a single session.
