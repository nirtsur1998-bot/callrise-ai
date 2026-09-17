# M40 Stage 2 — shipping the virtual mic: research, and the decisions that need the founder

**Written:** 2026-09-17, on the Mac. Research and options only. **Nothing has been built or
changed.** Companion to [`virtual-mic.md`](virtual-mic.md) (what the driver is) and
[`M40-stage1-mac-audit.md`](M40-stage1-mac-audit.md) (does the app run).

The goal: a Mac user downloads CallRise, installs it, and **Sales OS Microphone** is there.

---

## The research was measured, not read

Two shipping HAL plugins are installed on this machine, so "how do apps ship CoreAudio drivers"
was answered by inspecting them rather than by recalling documentation.

**Krisp is the ideal reference**: same product category, same problem, and — usefully — **also an
Electron app** (`Contents/Frameworks/Electron Framework.framework`), so its constraints are ours.

| | Krisp | ParrotAudioPlugin | **CallRise today** |
|---|---|---|---|
| signature | `Developer ID Application: Krisp Technologies, Inc. (U5R26XM5Z2)` | `macOS Software Signing` (Apple's own) | **ad-hoc** |
| hardened runtime | **yes** (`flags=0x10000(runtime)`) | — | no |
| secure timestamp | **yes** (29 Jun 2026) | — | no |
| notarized | **yes** (`spctl: accepted, source=Notarized Developer ID`) | Apple-signed | **no** |
| architecture | **universal (x86_64 arm64)** | arm64e | **thin arm64** |
| Team ID | U5R26XM5Z2 | not set | **not set** |

### How Krisp actually installs it — a signed component `.pkg`

Not a privileged helper, not `osascript`. macOS keeps a receipt, and it is unambiguous:

```
$ pkgutil --pkg-info ai.krisp.krispMac.audioDriver
package-id: ai.krisp.krispMac.audioDriver
version: 2.0

$ pkgutil --files ai.krisp.krispMac.audioDriver
Library/Audio/Plug-Ins/HAL/KrispAudio.driver
Library/Audio/Plug-Ins/HAL/KrispAudio.driver/Contents/Info.plist
…
```

Corroborating evidence, all consistent:

- `/Library/PrivilegedHelperTools/` contains helpers for Microsoft, NordVPN and Zoom — **none for
  Krisp**. So no `SMJobBless`.
- No Krisp `LaunchDaemon` or `LaunchAgent`.
- The driver is **not inside the app bundle** at all, and the main binary contains **no**
  `osascript` / `administrator privileges` / `/Library/Audio/Plug-Ins/HAL` / `coreaudiod` strings.
- The installed driver is dated Mar 2024 while the app was updated Sep 2026 — the driver is
  installed and versioned **separately** from the app.

**The pkg receipt is also the uninstall story**, which is the neatest part: a receipt means the
exact file list is recorded by the OS, so removal is `pkgutil --forget` plus deleting the recorded
paths — auditable, and not a script guessing at what it once wrote.

---

## THE DECISIONS — one list, for the founder

Nothing below is actioned. Each has a recommendation and the reason.

### 1. Install mechanism: embedded `.pkg`, or keep `osascript`?

Today `virtualmic.ts:157` runs one `osascript … with administrator privileges` that does
`rm -rf` + `cp -R` + `killall coreaudiod`. It works, it shows the OS's own password prompt, and it
is already written.

| | embedded `.pkg` (Krisp's way) | `osascript` (today) | `SMJobBless` helper |
|---|---|---|---|
| admin prompt | the standard Installer UI | the standard osascript prompt | one-time, then silent |
| uninstall | **receipt-backed, exact file list** | nothing recorded | helper must implement it |
| tamper surface | Apple-verified payload | **a shell string built with `${}` interpolation, run as root** | code you maintain as root |
| notarizable as a unit | yes | the app, not the operation | yes |
| effort | moderate (`pkgbuild`/`productbuild` + signing) | done | high, and a persistent root daemon |

**Recommendation: the embedded `.pkg`.** Beyond matching what a shipping peer does, the deciding
factor is the second row from the bottom. The current line is:

```ts
`do shell script "rm -rf '${DRIVER_PATH}' && cp -R '${source}' '${DRIVER_PATH}' && killall coreaudiod" with administrator privileges`
```

`source` comes from `resolveDriverBundleSource()`, i.e. from `process.resourcesPath` or
`app.getAppPath()`. Those are not attacker-controlled today, **and there is no evidence of a
vulnerability** — but this is an `rm -rf` composed by string interpolation and executed as root,
and a path containing a quote would break out of it. A `.pkg` removes the class of problem rather
than arguing about reachability. `SMJobBless` is rejected: a permanently-installed root daemon is
far more than this needs.

### 2. Signing — and the thing that is genuinely blocked today

**You have an Apple Developer Program membership, so this is not a money blocker. It is a
certificate blocker, and the certificates do not exist yet.** This keychain holds exactly one
identity:

```
1) "Apple Development: nirtsur1998@gmail.com (X7C2XR7YZ7)"   ← development only
   1 valid identities found
```

"Apple Development" signs builds for *your own registered devices*. It cannot sign anything for
distribution. Two **different** certificates are needed, and they are created in the Apple
Developer portal (Certificates → +), not by Xcode's default flow:

- **Developer ID Application** — signs the `.driver` bundle, the `.app`, and the helper binaries.
- **Developer ID Installer** — signs the `.pkg`. A separate certificate type; this is the one
  people discover late.

Also required, and separate again: an **app-specific password** (or an App Store Connect API key)
for `notarytool`.

**Founder action, in Apple's own screens — nobody else can do it:** create both Developer ID
certificates, and generate a notarization credential. Everything in Stage 2 is blocked on this.

Note that an ad-hoc signature is why the driver loads *today*: it was built locally and carries no
`com.apple.quarantine`. Shipped inside a download it will be quarantined, and Gatekeeper will
refuse it. **This is reasoned, not reproduced** — I did not build a signed DMG and test it on a
clean Mac.

### 3. Architecture: universal, or arm64-only?

**Krisp ships universal** (`x86_64 arm64`). That is the strongest single data point available, and
it is a direct peer.

Against: `build.sh` hardcodes `-arch arm64` in every compile and link step, and — the real cost —
`michelper` statically links **`libdf.a`, a 147 MB Rust staticlib built only for arm64**. A
universal `michelper` needs an x86_64 Rust build of DeepFilterNet, which means a second
`cargo build` of a ~1 GB vendored tree, in CI.

| | universal | arm64-only |
|---|---|---|
| Intel Macs | works | **device simply never appears** — a silent, confusing failure |
| artifact size | roughly double | smaller |
| build work | second Rust target + `lipo` | none |

**Recommendation: arm64-only for the first ship, universal before any broad launch** — but make
the exclusion *loud*. An Intel user today would install successfully and find no microphone, with
nothing telling them why. If arm64-only ships, the installer must refuse on Intel with a real
message, rather than the device quietly not existing. **That is the actual requirement; the
architecture is secondary to it.**

### 4. Uninstall — currently absent, and not shippable without it

There is `installDriver()` and no `uninstallDriver()`. Nothing in the app or in
`electron-builder.yml` removes `/Library/Audio/Plug-Ins/HAL/SalesOSMicrophone.driver`. Dragging
CallRise to the Trash today leaves an orphaned audio driver on a stranger's machine.

Choosing the `.pkg` route (decision 1) largely solves this: the receipt records the exact payload.
The remaining decision is **when** removal happens:

- **(a) An in-app "Remove the virtual microphone" button** in Settings → Audio. Explicit, reversible,
  and the user is present to authorise it. **Recommended.**
- (b) On app uninstall — macOS has no uninstall hook for a drag-installed app, so this only exists
  if the app itself ships an uninstaller.
- (c) Both.

Whichever: removal must also `killall coreaudiod`, or the device lingers until reboot.

### 5. The macOS floor must be one that was actually built and tested

`build.sh` passes `-mmacosx-version-min=11.0`, but linking `libdf.a` emits:

```
ld: warning: object file (…libdf.a[…]) was built for newer 'macOS' version (26.0) than being linked (11.0)
```

So **the macOS 11 floor is claimed, not established** — `michelper` may not run there at all.

This matters exactly as the founder framed it: a declared minimum that is not real means an older
macOS user gets a **crash**, not a clean refusal to install. `LSMinimumSystemVersion` in the app's
`Info.plist` is what produces the clean refusal, and it must be set to a version that was actually
built and tested against — not inherited from a compiler flag nobody verified.

**Recommendation:** pick the floor deliberately, rebuild the Rust staticlib against it, and set
`LSMinimumSystemVersion` to match. **A Stage 3 release gate, not a footnote.**

---

## What Stage 2 does NOT yet know

- **Whether `coreaudiod` needs restarting after a `.pkg` install.** Krisp's pkg presumably handles
  it in a postinstall script; I have not extracted and read that script. The manual sequence is
  documented and works (`sudo killall coreaudiod`, launchd respawns in ~1s), but "how a shipping
  pkg does it gracefully" is inferred, not read.
- **Whether the ad-hoc plugin genuinely fails from a quarantined download.** Reasoned from
  Gatekeeper behaviour and the confirmed ad-hoc signature; not reproduced on a clean Mac.
- **Notarization round-trip time and failure modes** — never run for this project.
- **Whether a `.driver` can be stapled.** Krisp's is not (`stapler validate` → *"does not have a
  ticket stapled to it"*), so the ticket presumably rides with the installer. Not investigated.
- **AudioDriverKit** (the newer DriverKit path) was not evaluated. Krisp still ships a HAL plugin
  in 2026, which is strong evidence the HAL path remains viable — but that is inference from one
  data point.
