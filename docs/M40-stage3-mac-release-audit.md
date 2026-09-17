# M40 Stage 3 — what a Mac release needs, audited by building one

**Written:** 2026-09-17, on the Mac, against `1.14.0` (rebased onto the HUD Instrument Panel work).

**Everything below was measured by producing a real Mac package**, not by reading config:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg zip --publish never
```

Unsigned on purpose — **none of this needed a certificate**, so it was all doable while the
Developer ID certs are being created.

**Headline: the Mac build works today.** It packages, the denoiser payload ships, the version
stamps correctly. Two things are wrong, one of them silently.

---

## What already works (verified in the produced .app, not assumed)

| | evidence |
|---|---|
| The build completes | `electron-builder` exit **0** |
| BUG-117's guard runs on Mac | `[verify-build-inputs] darwin: all 3 required build inputs present` |
| Electron fuses are applied | `[fuses] locked darwin: …/CallRise AI.app` |
| Version stamps correctly | `CFBundleShortVersionString = 1.14.0`, `CFBundleVersion = 1.14.0` |
| Bundle id | `ai.callrise.app` |
| **The denoiser payload ships** | `Resources/virtualmic/build/michelper` (32 MB), `…/build/SalesOSMicrophone.driver`, `…/phase2/models/DeepFilterNet3_onnx.tar.gz` (7.9 MB) — all three present inside the `.app` |
| `latest-mac.yml` **is** produced | see below — and this **corrects my Stage 1 claim** that it was not |

### Correction to the Stage 1 audit

Two things I reported in [`M40-stage1-mac-audit.md`](M40-stage1-mac-audit.md) were read off the
**stale 0.1.0 tree** and are wrong on 1.14.0:

- *"`publish.url: https://example.com/auto-updates` — a placeholder"* — **no longer true.** It is a
  real GitHub provider config with `releaseType: release`, carrying a long comment about v1.0.0
  having shipped as a silent draft.
- *"no `latest-mac.yml`"* — **wrong.** It is produced.

---

## BLOCKER 1 — macOS auto-update is broken as configured, and it fails silently to the user

`electron-builder.yml` has `mac.target: [dmg]`. That produces a `latest-mac.yml` listing only a
DMG. **electron-updater cannot update from a DMG.** From its own source,
`node_modules/electron-updater/out/MacUpdater.js:81`:

```js
const zipFileInfo = findFile(files, "zip", ["pkg", "dmg"]);
if (zipFileInfo == null) {
    throw newError(`ZIP file not provided: …`, "ERR_UPDATER_ZIP_FILE_NOT_FOUND");
}
```

It looks for a **zip**, and `["pkg", "dmg"]` is the explicit *exclusion* list. So every update check
on macOS would throw `ERR_UPDATER_ZIP_FILE_NOT_FOUND` — shipped Mac users would simply never
receive an update, with nothing on screen to say why.

This is read from the installed updater's source, not from memory or documentation.

### The fix, verified rather than proposed

Add `zip` to the Mac targets. Measured, building both:

```yaml
mac:
  target:
    - dmg   # what a human downloads and drags to Applications
    - zip   # what electron-updater actually consumes
```

`latest-mac.yml` then becomes:

```yaml
files:
  - url: CallRise-AI-1.14.0-arm64-mac.zip     ← the updatable artifact
  - url: callrise-ai-1.14.0.dmg
path: CallRise-AI-1.14.0-arm64-mac.zip        ← what electron-updater follows
```

`findFile(files, "zip", …)` now succeeds. **Not applied yet** — it changes what a release publishes,
which is the founder's call.

---

## BLOCKER 2 — three different macOS floors, none of them agreed

| where | value |
|---|---|
| the packaged app's `Info.plist` → `LSMinimumSystemVersion` | **12.0** |
| `salesos-virtualmic/build.sh` → `-mmacosx-version-min` | **11.0** |
| `libdf.a`'s own objects, per the linker | *"built for newer 'macOS' version (**26.0**)"* |

`LSMinimumSystemVersion = 12.0` is the only one a user ever feels: it is what makes macOS refuse to
launch the app cleanly instead of crashing. But the driver is compiled against 11.0, and the Rust
staticlib inside `michelper` carries objects built for **26.0**.

So the floor is **claimed three ways and established none**. A user on macOS 12 or 13 passes the
`LSMinimumSystemVersion` gate, launches fine, and then `michelper` may not run — which surfaces as
"noise cancellation doesn't work" with no explanation, not as a clean refusal.

**Recommendation:** pick a floor deliberately, rebuild `libdf.a` and the driver against it, and set
`LSMinimumSystemVersion` to match. **A release gate, not a footnote** — this is the founder's
stated position and I agree with it.

---

## Confirmed: arm64-only

```
$ lipo -archs "dist/mac-arm64/CallRise AI.app/Contents/MacOS/CallRise AI"
arm64
```

Already covered by the Intel refusal shipped in `211f7b7`, which is what turns this from a silent
missing-device into a message. Universal remains the eventual answer (Krisp ships universal); the
cost is a second Rust build of the ~1 GB DeepFilterNet tree for x86_64.

---

## Not a blocker, but verify at the first real release: manifest names

The manifest's URLs do not match the filenames on disk:

| manifest url | on disk |
|---|---|
| `CallRise-AI-1.14.0-arm64-mac.zip` | `CallRise AI-1.14.0-arm64-mac.zip` |
| `callrise-ai-1.14.0.dmg` | `CallRise AI Mac (arm64).dmg` |

The **zip** difference is expected and correct: `five-checks.mjs`'s own header records that *"GitHub
hyphenates asset names"*, so electron-builder writes the post-upload name. Since `path:` points at
the zip, the update path is fine.

The **dmg** entry is not a hyphenation of anything — `dmg.artifactName` is
`CallRise AI Mac (${arch}).${ext}`, and `callrise-ai-1.14.0.dmg` looks like electron-builder's
default pattern instead. **I have not run a real publish**, so I cannot say what GitHub ends up
hosting. It is off the update path, so it is a "check it once" rather than a blocker — and
`five-checks.mjs` follows the manifest's own `path`, which is the right instrument for it.

---

## What the release workflow needs

`.github/workflows/release.yml` is a **single `windows-latest` job**. A Mac release needs a second
job. Extending, not rebuilding — the Windows flow is proven.

### The six checks, on Mac

- **Checks 1–5** (`five-checks.mjs`) read the release feed and take the installer filename from the
  manifest's own `path:`. They are pointed at `latest.yml`; the Mac equivalent is `latest-mac.yml`.
  The logic is reusable as-is — it needs the manifest name parameterised.
- **Check 6** (`artifact-version.mjs`) is **Windows-only by construction**. It shells out to
  PowerShell for `(Get-Item …).VersionInfo.ProductVersion` against
  `dist/win-unpacked/CallRiseAI.exe`. The Mac equivalent, verified working on the artifact built
  above:

  ```bash
  /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
    "dist/mac-arm64/CallRise AI.app/Contents/Info.plist"     # -> 1.14.0
  ```

  **Check 6's part (b) caveat carries over and gets worse on Mac.** Its own docs say the
  post-dates-the-last-commit half compares file **mtime**, which is the *download* time for a
  fetched artifact and therefore proves nothing about anything downloaded. Same on Mac. Use the
  release run's `headSha` (`gh run view <id> --json headSha`) to ask whether a shipped artifact is
  current.

### Signing and notarization in CI

`mac.notarize: false` today. Both Developer ID certificates and a `notarytool` credential are being
created now — see [`M40-apple-certificates-runbook.md`](M40-apple-certificates-runbook.md). In CI
the certificate is a `.p12` in an encrypted GitHub secret, pasted into GitHub's own secret field,
never into a file or a commit.

### Runner choice

`macos-latest` is Apple Silicon, which matches the arm64-only build. If universal is ever adopted,
the x86_64 Rust build is the long pole, not the runner.

---

---

## The packaged build: the addon loads, and the virtual mic is reachable

Checked **without launching CallRise**, because the packaged app cannot be sandboxed — see the next
section. The shipped addons were `require()`d straight out of the `.app` from a throwaway Electron
process, which answers *"does it load"* rather than the weaker *"is the file present"*:

```
electron=39.8.10  node=22.22.1  modules=140          ← Electron's ABI, not system Node's

detection addon (mac-audio-activity)  arm64  LOADED
   exports=[getRunningConferencingProcesses, isMacOS14OrLater, getVirtualMicDeviceUID,
            getAudioInputActivity, getWindowTitles]
better-sqlite3                        arm64  LOADED
michelper (packaged path)                    exists=true
driver bundle (packaged)                     exists=true
DFN3 model (packaged)                        exists=true
```

**The `asarUnpack` path works on macOS.** The addon sits at
`app.asar.unpacked/native/mac-audio-activity/build/Release/mac_audio_activity.node` and loads with
its real exports — so the silent-never-loads failure CLAUDE.md documents is **not** present here.

The three virtual-mic resources are at exactly the paths `virtualmic.ts`'s `resolveHelperPath()` and
`resolveDriverBundleSource()` probe (`process.resourcesPath/virtualmic/...`), so the packaged build
is wired correctly. *Path-reachable is not the same as working* — nothing was started.

### One near-miss worth recording

My probe initially reported `active-win … FAILED  Module did not self-register`, which looks exactly
like a broken native module. **It was the probe.** `active-win` on macOS does not load a `.node` at
all — `index.js` routes darwin to `lib/macos.js`, which `execFile`s a separately compiled helper
binary (`node_modules/active-win/main`). I had required a `.node` the product never touches on this
platform.

The helper itself is fine: unpacked, executable, **universal (x86_64 + arm64)**, at
`app.asar.unpacked/node_modules/active-win/main`. Fourth instance this session of a probe reporting
a fact about itself as a fact about the app.

### Signing state of the shipped binaries

All ad-hoc, as expected for `CSC_IDENTITY_AUTO_DISCOVERY=false`: the `.app` bundle
(`ai.callrise.app`, `flags=0x2(adhoc)`), the detection addon, and active-win's helper. A real
Developer ID build is what changes these, and has not been done.

---

## Why the packaged app was not launched

`CALLRISE_USER_DATA_DIR` is gated on `!app.isPackaged` (`src/main/index.ts:85`), and **`HOME`
override does not move `appData` on macOS** — measured: `process.env.HOME` reads back the override
while `getPath('appData')` still returns `/Users/nirtsur/Library/Application Support`. Same shape as
the documented Windows `APPDATA` trap, now recorded in
[`scripts/verification/README.md`](../scripts/verification/README.md).

So there is **no sandbox mechanism for a packaged build**, and launching it would drive the real
profile — 271 MB, 42 calls, 11 contacts, 1 deal, 9 tasks — putting real client names into any
screenshot. That needs the founder's explicit say-so, not my inference.

---

## BLOCKER 3 (found 2026-09-18) — CI cannot build the Mac denoiser at all

Bigger than the certificates, because certificates are a form and this is build infrastructure.

`scripts/verify-build-inputs.js` (BUG-117) requires three paths on darwin and **refuses to package**
without them — correctly. Two of the three exist **only on this Mac**:

```
GITIGNORED  ../salesos-virtualmic/build/michelper
GITIGNORED  ../salesos-virtualmic/build/SalesOSMicrophone.driver
TRACKED     ../salesos-virtualmic/phase2/models/DeepFilterNet3_onnx.tar.gz
```

A macOS runner checks out both repos, finds the model, and stops. Producing the other two in CI
means rebuilding `libdf.a` (gitignored, 147 MB) from a ~1 GB vendored Rust tree at the pinned
DeepFilterNet commit, then `build.sh` — **and** a PAT to check out the private sibling repo, since
`GITHUB_TOKEN` is scoped to this repo only.

**This is the `TMP`-hardcoded-to-one-machine finding one level up:** the shipped denoiser can
currently only be produced on one computer. The macOS release job was deliberately **not written**
until the route is chosen, because its shape depends on it:

| route | cost | what it buys |
|---|---|---|
| **1. build virtualmic from source in CI** *(recommended)* | slow CI; Rust toolchain + cache | the denoiser becomes reproducible instead of machine-bound |
| 2. publish virtualmic's build output as release assets, download in CI | fast CI | artifacts still born on one machine, now trusted at a distance |
| 3. commit the binaries to the virtualmic repo | trivial | 32 MB+ of binaries in git, drifting from source |

All three need the PAT (or making the sibling repo public). **Founder decision.**

### Also for the first signed release: `safeStorage` and the signature change

`safeStorage` on macOS binds its Keychain item to the app's code signature. Measured here: the dev
Electron binary **cannot decrypt** the session file the packaged app wrote (`DECRYPT FAILED`, both
copies, `isEncryptionAvailable = true`). Sessions, Google/Outlook tokens and every AI key are stored
this way. The first Developer-ID-signed build is a new signature. Whether existing users are
silently signed out and lose their keys on that upgrade is **reasoned, not measured** — and it must
be tested on a machine that has data under the old signature *before* that release goes out.

---

## What this audit did NOT verify

- **No signed build, no notarization round-trip.** Both need the certificates. Nothing here says
  what notarization will reject.
- **No publish.** `--publish never` throughout, so nothing was uploaded and the manifest-vs-GitHub
  naming question above is genuinely open.
- **The produced app was never launched.** This audit is about packaging; that it packages does not
  mean the packaged app runs. In particular the detection addon's `app.asar.unpacked` path — the
  documented silent-never-loads failure — was **not** exercised.
- **`ERR_UPDATER_ZIP_FILE_NOT_FOUND` was not reproduced at runtime.** It is read from the installed
  `MacUpdater.js`, which is strong, but no update check was actually run against a dmg-only feed.
- **The DMG was never mounted or installed from.**
