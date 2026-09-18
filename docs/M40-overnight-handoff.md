# M40 — overnight handoff, 2026-09-18

Written while the founder slept, on the Mac, on branch `claude/m40-mac-parity` (both repos).
**Nothing pushed. Nothing published. Your working driver untouched** (`563ca8b1…`, verified).

Read top to bottom: what changed, what was proven, what needs you, what I did not do.

---

## The one-paragraph version

The Mac is closer than the audit made it sound. **The full test suite is green on macOS** — the
79 failures were a Node-version drift, not a platform defect, and are now guarded against
mechanically. The Mac package builds, the detection addon loads from `app.asar.unpacked` under
Electron's ABI, auto-update is fixed (zip target), check 6 and checks 1–5 have Mac paths, the floor
is 12.0 where we control it, the Intel refusal ships, and the uninstall button exists. What's left
splits cleanly: **certificates** (yours, in progress), **one build-infrastructure decision** (how CI
gets the denoiser — see §3), and **things only real hardware or a real login can close**.

---

## 1. Proven green — the test suite, on macOS

```
Node 22 (CI's version):  Test Files 468 passed | 3 skipped     Tests 4517 passed | 15 skipped   exit 0
Node 26 (this Mac's):    14 files / 79 tests failed — all but two on one cause
```

**Cause:** Node ≥ 25 ships its own `localStorage` global that shadows happy-dom's. Proven on one file:
Node 26 → 4 failed, Node 22 → 4 passed. `sessionStorage` untouched is the tell.

**Fixed mechanically** (`19827f8`): `.nvmrc` + `package.json#engines` = 22.x; a setup-file guard
that fails **once** with the exact remedy instead of 79 times. Red / green / quiet all verified.

**The escalation to the Windows session is answered:** verify-green is not red there if it runs
Node 22. Nothing suggests otherwise.

---

## 2. What shipped tonight (all on `claude/m40-mac-parity`, all unpushed)

| commit | what | verified how |
|---|---|---|
| `89f5f82` | check 6 reads `CFBundleShortVersionString` from the `.app` (`--app`, or auto-detect) | RED on a genuinely stale artifact ("4 min OLDER"), GREEN after rebuild — found its own test case |
| `9d3f0e0` | checks 1–5 point at `latest-mac.yml` with `--mac`; expected assets derived from the manifest; `TMP` no longer hardcoded to one Windows machine; check 3 counts instead of saying "four" | parses; derivation verified against the real manifest (`path:` → the ZIP). **Never run against a real feed** — no Mac release exists |
| `c910a89` | uninstall button (`uninstallDriver()`: stops helper, restarts coreaudiod, reads the result back) | typecheck, 50 tests, IPC exposed. **Control never seen rendered, never executed** — see §4 |
| `9222f67` | locality-claims gate: ACCOUNTED_FOR entry for the Intel-refusal copy | was FAIL on my sentence; 11/11 now. **Says it is not yet founder-approved — read it once** |
| `19827f8` | Node guard + pins (§1) | red/green/quiet |
| virtualmic `3fd08d0` | `build.sh` 11.0 → 12.0, both linked binaries now declare 12.0 | rtsafetytest PASS, underruntest 562/562, signature valid |

Plus earlier today: zip target (`8e760a0`), Intel refusal, tier1 gate, screen-sweep fix (call-detail
screens swept for the first time on any platform), `run.mjs`, tier1-diagnostics separators.

---

## 3. Needs YOU — one list

1. **Certificates** — Developer ID Application + Installer + `notarytool` credential (runbook in
   `M40-apple-certificates-runbook.md`). Reply "done".
2. **How CI gets the denoiser.** `verify-build-inputs.js` requires `michelper` and the `.driver`,
   both **gitignored, existing only on this Mac**. A macOS release job cannot pass until you pick:
   build from source in CI (recommended — makes it reproducible), publish virtualmic build output as
   release assets, or commit the binaries. All three need a **PAT** for the private sibling repo.
   The job was deliberately not written blind. Detail: `M40-stage3-mac-release-audit.md` §Blocker 3.
3. **Log into the sandbox once** so the authenticated screen tour can run. The README's two-file
   sign-in trick is **Windows-only** — on macOS `safeStorage` is Keychain-bound to the writing app's
   code signature, and the dev binary cannot decrypt the packaged app's session file (`DECRYPT
   FAILED`, measured). I will not enter credentials. Command to relaunch the sandbox is at the end.
4. **Read the ACCOUNTED_FOR entry** in `no-false-locality-claims.test.ts` for the Intel copy and
   either approve it or tell me to reword.
5. **Before the first signed release:** test on a machine with data under the *old* signature
   whether sessions and AI keys survive the signature change. `safeStorage` binds to the signature;
   what happens to existing users is **reasoned, not measured** (§ in the Stage 3 audit).
6. **Sidebar "Calls" no-op from an open call** — still yours/the Windows session's; test Home /
   Pipeline / Coaching from a detail page to settle severity (§1 in `M40-known-issues.md`).

---

## 4. What I did NOT do, and why

- **Did not click Remove.** It would uninstall your working driver. The path is verified to the
  IPC surface only.
- **Did not launch the packaged `.app`.** No sandbox mechanism exists for a packaged build on
  either platform (`CALLRISE_USER_DATA_DIR` is gated on `!app.isPackaged`; `HOME` override does not
  move `appData` on macOS — measured). Launching it drives your real 271 MB profile. The addon
  question was answered without it: `require()`d from the `.app` under Electron's ABI → **LOADED**.
- **Did not do the authenticated screen tour.** Blocked on §3.3. The two no-auth screens (login,
  sample call) are verified in **both themes** — background moved, hashes differ, driven via the
  stored preference not the class. Screenshots delivered.
- **Did not write the macOS release job.** Blocked on §3.2; writing it would embed a guess about
  a secret that does not exist.
- **Did not run on macOS 12.** The floor is declared and built against 12.0, never executed on it.
  Stays open until real hardware.
- **Did not push.** Both repos are on `claude/m40-mac-parity`, `main == origin/main` on both,
  verified on four conditions each.

---

## 5. Instruments that were wrong tonight, caught

- A probe reported `active-win — Module did not self-register`: the probe's fault; macOS active-win
  `execFile`s a helper and loads no `.node`.
- `console.log` inside a vitest test printed nothing — vitest swallows it; rewrote the probe to a
  file. A "0 lines" that was about forwarding, not the environment.
- A `7.2 % stale` reading from `underruntest`: my harness starting the reader before the writer.
  Primed first → 562/562.
- Three different sandbox-navigation probes measured the wrong page (Settings replaces the
  sidebar; a stale-coordinate re-entry; a predicate that looked for collapsed transcript text).
- **Morning:** a background `npm test` picked up Node 26 from `PATH` (`.nvmrc` says 22; nothing
  enforces it for a bare `npm test`) and reported **53 failed files**. `node-webstorage-guard`
  fired once with its full message — the first time it has caught the real thing rather than its
  own red-check. Re-run with `npx -y node@22 node_modules/vitest/vitest.mjs run`. The lesson is
  the guard's own: a Node-version problem that reads as 53 platform failures, and a runner that
  does not pin its Node is a runner that will produce this again.

---

## To resume the sandbox

```bash
cd /Users/nirtsur/callrise-ai
CALLRISE_USER_DATA_DIR=/private/tmp/claude-501/-Users-nirtsur-callrise-ai/adb440c9-f048-474a-8d09-6c00976cfdbe/scratchpad/sandbox3 \
SALESOS_MICHELPER_PATH=/Users/nirtsur/salesos-virtualmic/build/michelper \
  npx electron out/main/index.js --remote-debugging-port=9401
```

`sandbox3` is already signed in (the founder's real profile copied minus every data store, then
seeded with invented records). **The `SALESOS_MICHELPER_PATH` override is required in this launch
shape** — see §6 below for why.

---

## 6. Morning update — 2026-09-18, after the founder's answers

**Sign-in solved without credentials.** The founder's instruction was to load the existing profile
into the dev app. `sandbox3` = the real `userData` minus calls/tasks/contacts/deals/events/knowledge
(so no real client name can reach a screenshot), seeded through the app's own IPC with obviously
fictional records. The sealed API keys came with it — **the API keys page is never visited**.

**The authenticated tour ran: 10 screens × 2 themes, 20/20 verified.** Each screen asserts a
destination marker that is not the sidebar, the rendered `body` background moved between themes,
and the PNG hashes differ. Contact sheets delivered (`M40-mac-tour-dark.png`, `-light.png`).
The **Remove control is now seen rendered** in both themes (Settings → Audio), still never clicked.

**One console error found and fixed — `ca70a25`.** The tier1 gate I added earlier registered
*nothing* off Windows, and `recorder.ts`'s teardown calls `tier1Api.stop()` unconditionally, so
every Live-screen teardown on macOS threw `No handler registered for 'tier1:stop'`. screen-sweep's
console probe caught it (1 error), `registerTier1Unsupported()` keeps the four channels registered
with platform-true answers, sweep re-run → 0 with the same teardown path exercised. The lesson is in
the code comment: **absent handlers are not the same as inert ones.**

**Capture started by itself on Calls → Live — expected, not a defect.** The copied profile carries
your real preference `salesos.settings.autoStartListening = true` ("Auto-start when you join a
call"), so opening the Live tab starts mic capture by design. In the sandbox, transcription was
refused by the egress gate (Deepgram is blocked), no call was saved, and the capture died with the
page reload. I set that preference to `false` **in the sandbox only** so the tour is read-only again.
Your real profile is untouched.

**Sidebar RECENT rows that point at calls which no longer exist do nothing.** The copied
`salesos.recentlyViewed` names calls absent from the sandbox; clicking one highlights the row and
opens nothing — no error, no removal of the stale row. Observed twice, not investigated; a user who
deleted a call could see the same. Logged here rather than in known-issues because severity is
unassessed.

**"The noise-cancellation engine couldn't be found on disk" on Settings → Audio is a launch-shape
artefact, measured.** `resolveHelperPath()`'s dev candidate is `app.getAppPath()/../salesos-virtualmic/
build/michelper`. Under `npx electron out/main/index.js`, `app.getAppPath()` is **`out/main`**
(measured with a probe), so the candidate resolves to `out/salesos-virtualmic/…`, which does not
exist. `npm run dev` and the packaged app take other candidates (root, `resourcesPath`) — the
packaged one is the one `verify-build-inputs.js` guards. Relaunched with `SALESOS_MICHELPER_PATH`
→ `helperAvailable: true`, `helperRunning: false`. Nothing was started.

**Route 1 inputs, measured on this Mac (the founder's three asks):**

- **Cold `cargo build` of libdf: 48 s** (`cargo clean` first), M-series, *without*
  `MACOSX_DEPLOYMENT_TARGET`. **With `MACOSX_DEPLOYMENT_TARGET=12.0` the cold build fails**
  (`E0463`, can't find crate `time_macros`), reproduced from a full clean; the env var is the
  reproducible trigger, the mechanism is not established. So CI must **not** set it for cargo; the 12.0 floor is
  applied by `build.sh`'s `-mmacosx-version-min=12.0` at link time, which is where it was verified.
  `libdf.a` was restored byte-identical after every attempt (`b6079d8b…`).
- **Rust is preinstalled on GitHub's `macos-15` runner** (runner image README: Cargo 1.98.1,
  Rustup 1.29.0, Node 22.23.2) — no `dtolnay/rust-toolchain` step needed, though pinning one is
  cheap insurance against image drift.
- **Cargo.lock drift:** the vendored DeepFilterNet's `Cargo.lock` as built on this Mac differs from
  the pinned commit's. Both are backed up (`~/CallRiseAI-VirtualMic-Backup/source-build-artifacts/`,
  `DeepFilterNet-Cargo.lock.as-built-on-this-mac` sha `6e54b54e…`). CI should build with
  `--locked` against the **as-built** lock to reproduce this binary, not the pinned one.
- **PAT — minimum scopes.** Fine-grained token, **Repository access: only `salesos-virtualmic`**,
  permissions **Contents: Read-only** and **Metadata: Read-only** (Metadata is added automatically).
  Nothing else. Read-only is sufficient: the job only clones. Store as `VIRTUALMIC_REPO_TOKEN`.

**First runs on GitHub, 2026-09-18 (tag `v1.15.0-test.1`, throwaway branch `m40-mac-test-run`):**
run 1 (`35327765759`) — Windows failed on one real-time test (`multichannel-fallback`, untouched,
green on the next run: a runner-timing flake) and its diagnostics step hid the artifact (`find dist`
under `bash -e`, fixed `9eab8ff`). Run 2 (`35330742059`) — **Windows green; macOS green through
every step up to packaging**: libdf.a from source **179 s** cold on `macos-15` (48 s here), `build.sh`
22 s, npm ci 23 s, addon 3 s, full suite 304 s. Failed at electron-builder's certificate import —
`MAC verification failed during PKCS12 import (wrong password?)` — i.e. the `MAC_CERT_PASSWORD`
secret did not match the `.p12`. Human-entered; fix is re-saving the secret and re-running the
failed job. Re-run with a fresh `.p12`: certificate imported, identity found, signing started — and
**`mac.binaries` failed**: app-builder-lib resolves relative entries against the `.app` root
(`path.resolve(appPath, d)`), not `Contents/` as its own comment claims; the paths now carry the
`Contents/` prefix (`30347da`). Run 3 (`35349005291`) is the first to get past that line.
Run 3 got past signing — the `.app` **and both nested denoiser binaries signed with the Developer
ID** — and failed notarization with HTTP 401: the app-specific password secret carried a trailing
newline from a triple-click copy (clipboard was 20 chars; the password is 19). A fresh app-specific
password was generated, **verified against Apple from this Mac first** (`xcrun notarytool history`
→ authenticated), stored trimmed, and the job re-run. That re-run's submission
(`58e2e693-ff5b-4011-adb5-e88acde4ad18`, "CallRise AI.zip") was **In Progress at Apple** for 20+
minutes at time of writing — first submissions from a new team can take an hour.
**Run 3's re-run: Apple ACCEPTED the notarization** (51 minutes in the queue), and every artifact
check passed on the runner — Developer ID authority on the `.app` and on both nested denoiser
binaries, `stapler validate`, `spctl`, check 6. It then failed at the upload step's read-back:
`latest-mac.yml` said `CallRise-AI-1.15.0-test.1-arm64-mac.zip`, GitHub had stored the file as
`CallRise.AI-…` (space → dot). **A shipped Mac updater would have 404'd on every check** — the
read-back exists for exactly this. Fixed by a space-free `mac.artifactName` (`80f6042`); run 4
(`35359158524`) is the first that can reach go-live.
**Not yet reached as of run 3:** the upload read-back, go-live, checks 1–5.

**Lesson worth keeping:** every credential that a human pasted failed once (PAT name too long;
`.p12` password mismatch; app-specific password with a newline). Every value that was verified
by a command *before* being stored worked first time. The runbook should say: test the credential
locally, then store it.

**Secrets and certificates, done this morning:** fine-grained PAT (`callrise-ai-release-ci-virtualmic`,
`salesos-virtualmic` only, Contents + Metadata read-only, expires 2027-09-18); Developer ID
Application and Installer certificates issued under Team `THC746RHPV` (expire 2031-09-17), installed
and chain-verified on this Mac; all six repo secrets present. `salesos-virtualmic` `main` is
fast-forwarded to the M40 branch and pushed (`build-libdf.sh` is on `main`).

**Still needs you (delta from §3):** §3.3 is done. §3.1 certificates ("done" per your message —
I have not verified them on this machine), §3.4 approved (`8d89928`), §3.5 and §3.6 unchanged,
plus the PAT above.

**The macOS release job is written — `a1422a0`** (supersedes §3.2 and §4's "did not write"):
`release.yml` is three jobs under one tag — `windows` (unchanged apart from go-live moving out),
`macos`, `go-live` (needs both, stages both manifests, flips, then checks 1–5 per platform). The
macos job builds the denoiser from source (`phase2/build-libdf.sh` → `build.sh`), packages with
`--publish never`, and uploads only after reading the artifact: Developer ID authority on the
`.app` and on both nested denoiser binaries, `stapler validate`, `spctl`, the "notarization
successful" log line, check 6. It refuses up front without all six secrets, by name. **It has never
run.** Before the first run: (1) add the six secrets; (2) merge `salesos-virtualmic`'s
`claude/m40-mac-parity` into its `main`, or point the checkout `ref` at the branch — `build-libdf.sh`
does not exist on `main`; (3) expect `mac.binaries` and notarization to be tested for the first time
there, not here. A prerelease tag (`v1.15.0-test.1`) is the safe first run: invisible to the updater.
The release notes still say "for Windows" and name no Mac asset — yours to change, a test pins them.
