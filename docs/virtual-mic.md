# The Sales OS Microphone virtual mic — what it is, where it lives, how to not break it

**Written:** 2026-09-17, on the Mac, as Stage 0 of M40 (Mac parity).
**Status of this doc:** Stage 0 was findings-only. Two changes were then made and
installed with founder approval — see [What shipped](#what-shipped-on-2026-09-17) —
and one earlier finding in this doc is [retracted](#retracted-the-measurable-discontinuities-finding-and-the-claim-about-underruntest).

This is the handoff doc back to the Windows machine. Everything here was read off
the live Mac, not inferred from the repo.

---

## TL;DR

- It is a **CoreAudio HAL plugin** (`AudioServerPlugIn`) — a user-space bundle, **not**
  a DriverKit system extension, **not** a kext. No kernel component.
- It is **built from source**, in a **separate repo** (`salesos-virtualmic`), on top of
  **libASPL (MIT)**. It is **not** BlackHole and contains no GPL code — that was a
  deliberate commercial-licensing decision, documented in that repo's README.
- It is **ad-hoc signed** (`Signature=adhoc`, `TeamIdentifier=not set`). This is the
  single biggest blocker for Stage 2 — see [Signing](#signing-the-stage-2-blocker).
- It is **arm64-only**. There is no Intel slice.
- It is **input-only** (2 in / 0 out). See [the founder's premise](#one-correction-to-the-brief).
- It got installed by the app itself, via an `osascript … with administrator privileges`
  prompt in `src/main/virtualmic.ts`.

---

## Backup — done first, before anything else

Location: `~/CallRiseAI-VirtualMic-Backup/` (outside both repos, 173 MB total).

| Item | Why it's irreplaceable |
|---|---|
| `SalesOSMicrophone.driver/` | The **installed, working** bundle, copied from `/Library/Audio/Plug-Ins/HAL/` with `ditto` (preserves xattrs + signature) |
| `SalesOSMicrophone.driver.tar.gz` | Second-form archive of the same |
| `source-build-artifacts/michelper` | 32 MB denoiser helper — `build/` is **gitignored**, so this binary exists nowhere else |
| `source-build-artifacts/libdf.a` | 147 MB DeepFilterNet3 Rust staticlib — `phase2/vendor/` is **gitignored**; **without this, `michelper` cannot be rebuilt at all** |
| `source-build-artifacts/SalesOSMicrophone.driver-repobuild-632b5fe/` | The newer, **never-installed** build (see [two builds](#there-are-two-builds-and-they-are-not-the-same)) |

**Verification of the backup** (not "the copy command exited 0"):

```
per-file SHA-256, original vs backup — all three match:
  d880969c…  Contents/Info.plist
  563ca8b1…  Contents/MacOS/SalesOSMicrophone
  6686de10…  Contents/_CodeSignature/CodeResources
diff -r  → no differences
codesign --verify --deep --strict  → "valid on disk", "satisfies its Designated
                                      Requirement" on BOTH original and backup
```

The three `source-build-artifacts` files were each SHA-256 compared against their
source and matched.

One expected difference: the backup is owned `nirtsur:staff`, the original is
`root:wheel` — a non-root copy cannot preserve ownership. **On restore, the copy
back must go through `sudo cp -R`**, which re-establishes root ownership. File
*contents* are byte-identical, which is what matters.

---

## 1. What is it

A **CoreAudio AudioServerPlugIn** — the modern user-space way to publish a virtual
audio device. Evidence, from the installed bundle's `Info.plist`:

```
CFBundleIdentifier  com.salesos.virtualmic
CFBundlePackageType BNDL
CFPlugInTypes       443ABAB8-E7B3-491A-B985-BEB9187030DB  ← kAudioServerPlugInTypeUUID
CFPlugInFactories   38D57795-… → SalesOSVirtualMic_Create
sandboxSafe         true
CFBundleShortVersionString 0.2.0
```

It links only `CoreAudio`, `CoreFoundation`, `libc++`, `libSystem` — no third-party
runtime. `coreaudiod` dlopens the bundle and calls `SalesOSVirtualMic_Create` by name.

**Device identity as macOS sees it, read live from this machine:**

| Property | Value |
|---|---|
| Name | `Sales OS Microphone` |
| Manufacturer | `Sales OS` |
| Channels | **2 in, 0 out** |
| Sample rate | **48000** (was 44100 until 2026-09-17 — see [What shipped](#what-shipped-on-2026-09-17)) |
| Transport | **USB** (`coreaudio_device_type_usb`) |

The USB transport is deliberate, not an accident. From `src/Driver.cpp`: libASPL's
default is `kAudioDeviceTransportTypeVirtual`, and **WhatsApp Desktop filters
virtual-transport devices out of its mic picker entirely**. Presenting as USB is what
makes the device selectable there. The comment notes USB was chosen over BuiltIn
specifically to avoid macOS applying built-in-mic handling. Transport type is purely
informational — it changes nothing about capture.

### How audio actually flows

```
real mic ──▶ michelper (separate process, 32 MB)
                 │  captures via raw CoreAudio at 48 kHz mono float
                 │  denoises in place with DeepFilterNet3 Standard, beta 0.08
                 │  duplicates mono to stereo int16 at 48 kHz — NO resample
                 │  (this step resampled 48k -> 44.1k until 2026-09-17)
                 ▼
          POSIX shared memory ring: /salesos.vmic.ring1
                 ▼
     SalesOSMicrophone.driver  (inside coreaudiod, on the RT IO thread)
                 ▼
          "Sales OS Microphone" ──▶ Zoom / WhatsApp / Teams / …
```

**Fail-safe design, which is the part worth respecting:** if `michelper` isn't running,
publishes a mismatched format, or its heartbeat is older than 300 ms, the driver
emits **silence**. Never stale audio, never a hang. Every non-`Ok` read status ends in
`memset(bytes, 0, …)`. This was tested before the driver was ever installed.

Diagnostics — **with two corrections the repo's own version of this line gets wrong**:

```bash
/usr/bin/log stream --predicate 'subsystem == "com.salesos.virtualmic"' --level info
```

1. Use **`/usr/bin/log`**, not `log`. `log` is a **zsh builtin** and silently shadows the
   macOS tool, failing with `(eval):log:2: too many arguments` — which reads as "no
   entries" if you only look at the output.
2. Use **`log stream`**, not `log show`. These are `os_log` **info**-level messages, which
   are not persisted to the archive, so `log show` returns nothing after the fact even
   when they were emitted.

Caveat: even done correctly, streaming from inside `coreaudiod` produced nothing usable on
this machine, so the driver's own logs are **not currently a reliable instrument** here.

---

## 2. Built from source, or third-party binary?

**Built from source**, in a separate repo — `/Users/nirtsur/Projects/salesos-virtualmic`,
symlinked to `~/salesos-virtualmic` (the symlink matters: `electron-builder.yml` refers to
`../salesos-virtualmic`, which resolves through it).

Provenance, per that repo's README and `Info.plist`'s copyright string
(*"Portions Copyright (c) libASPL authors (MIT)"*):

- **libASPL** — MIT, vendored at `third_party/libaspl`, pinned to upstream
  `633e0f70203edd87d320fc5a3cae901e1363aac5`. **Tracked in git.**
- **Apple's NullAudio sample** — the superseded Phase 0 driver, kept at
  `src/legacy-nullaudio/`, no longer built.
- **DeepFilterNet3** — dual MIT/Apache-2.0, from `Rikorose/DeepFilterNet` at commit
  `d375b2d8309e0935d165700c91da9de862a99c31`.

The README is explicit and worth quoting to a lawyer later: no BlackHole or GPL code is
used or referenced, in order not to contaminate a future commercial product. Other
virtual-audio projects were consulted for *documentation only*. That's a real asset —
don't undo it by borrowing from BlackHole during packaging work.

Only ~170 lines of the driver are first-party (`src/Driver.cpp`); libASPL does the
AudioServerPlugIn object-graph work.

---

## 3. Signing — the Stage 2 blocker

```
$ codesign -dvvv /Library/Audio/Plug-Ins/HAL/SalesOSMicrophone.driver
Identifier=com.salesos.virtualmic
Format=bundle with Mach-O thin (arm64)
CodeDirectory v=20400 … flags=0x2(adhoc)
Signature=adhoc
TeamIdentifier=not set
```

`build.sh` does `codesign --force --sign -` — an ad-hoc signature, no identity. The
README is honest that this is a local-development choice: *"No Apple Developer account
is needed until distribution."*

**Why this works today and will not work when shipped:** an ad-hoc signature satisfies
Apple Silicon's *"must be signed with something"* rule, which is why the plugin loads on
this machine. But this bundle was built locally and therefore carries no
`com.apple.quarantine` attribute. A plugin that arrives inside a downloaded DMG *will*
be quarantined, and then Gatekeeper requires a **Developer ID** signature plus
**notarization**. An ad-hoc HAL plugin extracted from a downloaded DMG will not load on
a stranger's Mac.

The founder has confirmed an **Apple Developer Program membership already exists**, so
this is not a money blocker — it is a "wire the Developer ID cert into `build.sh` and
the CI" task. Detail for Stage 2:

- The `.driver` bundle needs its own `Developer ID Application` signature with
  hardened runtime, **and** it must be notarized. It is notarized as part of whatever
  container ships it (the app's DMG, or a `.pkg`).
- `build/entitlements.mac.plist` today grants only JIT / unsigned-exec-memory /
  dyld-env — those are Electron's needs, not the driver's. The driver bundle should
  **not** inherit them.
- `electron-builder.yml` currently has `mac: notarize: false` and no signing identity.

**Also arm64-only.** `build.sh` hardcodes `-arch arm64` in every compile and link step.
There is no x86_64 slice, so on an Intel Mac the device simply will not appear. That is a
Stage 3 architecture decision, and it is not just about the Electron app — the driver
and `michelper` would each need a second slice, and `michelper` links a Rust staticlib
(`libdf.a`) that would itself need an x86_64 build.

`-mmacosx-version-min=11.0` — so macOS 11 Big Sur is the floor as built.

---

## 4. How it got installed on this machine

By the app, not by hand. `src/main/virtualmic.ts:157`:

```ts
const script = `do shell script "rm -rf '${DRIVER_PATH}' && cp -R '${source}' '${DRIVER_PATH}' && killall coreaudiod" with administrator privileges`
await execFileAsync('/usr/bin/osascript', ['-e', script])
```

One `osascript` call → one native admin-password prompt → remove stale copy, copy in,
restart `coreaudiod`. Handles user-cancel (`-128`) as a distinct `'cancelled'` result.
The README documents the identical manual commands as the fallback.

This already answers one of Stage 2's research questions: **the privilege-escalation
mechanism that is shipping today is `osascript with administrator privileges`.** Whether
that should remain the mechanism (versus an embedded `.pkg` or an `SMJobBless` helper) is
a Stage 2 decision for the founder, since it installs at admin level on a stranger's
machine.

**Uninstall is not implemented.** There is `installDriver()`, `start()`, `stop()` — no
`uninstallDriver()`. Nothing in the app or in `electron-builder.yml` removes
`/Library/Audio/Plug-Ins/HAL/SalesOSMicrophone.driver` when the app is deleted. Dragging
CallRise to the Trash today leaves an orphaned audio driver behind. The brief calls that
unacceptable, and I agree — flagging it as a Stage 2 requirement, not a nice-to-have.

---

## 5. What the app does with it

`src/main/virtualmic.ts` (408 lines) owns the whole lifecycle. Notably, **this file is
byte-identical between the stale local checkout and `origin/main`** (blob
`6759100`) — the virtual-mic integration has not changed in the 841 commits this Mac is
behind. That is the one piece of good news about the staleness.

- `resolveHelperPath()` / `resolveDriverBundleSource()` — search order: `SALESOS_MICHELPER_PATH`
  env override → `resourcesPath/virtualmic/build/…` (packaged) → `../salesos-virtualmic/build/…`
  (dev sibling). `michelper` resolves its model file relative to its own binary, so it must
  live in a tree that has `phase2/models/` beside `build/`.
- `start()` requests **microphone permission before spawning** `michelper` (deliberate:
  the helper would otherwise trigger its own prompt and a slow first-run user would race it),
  `pkill`s any stray helper synchronously first, then spawns.
- Crash-notify + auto-restart, with an explicit guard against respawning into a tight
  crash loop.
- Renderer side: `features/audio/useVirtualMic.ts` + `NoiseCancellationCard.tsx`, surfaced
  on Home and in the Copilot panel.
- IPC: `virtualmic:getStatus` / `:start` / `:stop` / `:installDriver`.

Packaging is already wired in `electron-builder.yml` under `mac.extraResources` — it
copies `michelper`, the `.driver` bundle, and the DFN3 Standard model out of the sibling
repo. It **copies already-built output; it does not build that repo.** So a Mac CI job
must build `salesos-virtualmic` first, which means CI needs `libdf.a`, which is a ~1 GB
gitignored Rust tree. That is a real Stage 3 problem and I'd rather name it now.

---

## Hazards found while looking

### There are two builds, and they are not the same

| | Installed (`/Library/…/HAL/`) | Repo `build/` |
|---|---|---|
| SHA-256 | `563ca8b1…` | `2e57b712…` |
| Built | 2026-07-04 23:07 | 2026-07-14 23:58 |
| Corresponds to | `9b27dd2` (USB transport) | `632b5fe` (RT-safety fix) |

The timestamps reconcile cleanly — each binary was built ~20 minutes *before* the commit
that captured its source, i.e. build-test-then-commit.

**The working driver the founder values is the OLDER one.** The newer build exists on
disk but was **never installed**. What it changes is not cosmetic: `632b5fe` moves
`shm_open`/`fstat`/`mmap`/`munmap` off the real-time audio thread into a background
thread, because blocking syscalls on the RT thread risk audible glitches — and live
denoising had just reduced the headroom to absorb one.

So: the currently-installed driver has a **latent real-time-safety defect that a newer,
already-built, never-installed binary fixes.** Installing it is probably correct, but it
would change the thing the founder asked me not to break, and it has never run in place.
**Founder decision, not mine.**

### `build.sh` deletes before it checks

`build.sh:19` is `rm -rf "$OUT"`. The guard that checks for `libdf.a` is at line 90, and
`exit 1`s. So running `./build.sh` on a machine where `libdf.a` has gone missing
**destroys `build/michelper` and then cannot rebuild it.** Since both `build/` and
`phase2/vendor/` are gitignored, that is unrecoverable without the backup I just made.

`libdf.a` is present right now (147 MB, 2026-07-03). It is now also in the backup.

### The 1 GB gitignored dependency

`phase2/vendor/DeepFilterNet` is ~1 GB and gitignored. `.gitignore` documents the rebuild
recipe (clone at the pinned commit, `cargo build --release -p deep_filter --features "capi,tract"`),
which is good practice — but it means any fresh machine or CI runner needs a Rust
toolchain and a long build before it can produce `michelper`.

---

## One correction to the brief

The brief says the device *"shows up in System Settings → Sound under both Input and
Output."* **It does not.** It is input-only — `in=2, out=0`, confirmed three ways: the
live `system_profiler` JSON, `Driver.cpp` (`AddStreamWithControlsAsync(Direction::Input)`,
with a comment explaining the "2 ins / 0 outs" goal), and the README's acceptance criteria.

The likely source of the impression: **Krisp is also installed on this machine and ships a
*pair* of devices** — `krisp microphone` (1 in) and `krisp speaker` (2 out). The Output
entry seen was almost certainly Krisp's.

This matters for Stage 2 rather than being a nitpick: if the product ever wants to *place*
audio (play something into a call), that is a **second device** to build, install, sign and
uninstall — not a flag on this one.

### An instrument I got wrong, and caught

My first pass at tabulating channel counts used an `awk` range expression and printed
`in=- out=-` for **every** device, including the built-in mic. That is a false zero: the
mechanism was broken, not the population empty. Re-running against
`system_profiler -json` gave correct counts for every device. Flagging it because the
same shape of error — a zero that means "my parser missed it" — is the one this project
has been burned by before.

---

## What I did NOT verify

- **I did not test audio actually flowing.** I did not run `michelper`, did not record from
  the device, did not confirm the denoiser produces clean audio. Everything above about
  the audio path is read from source, the README and the live device list — not heard.
- **I did not install, reinstall, modify, or restart anything.** `coreaudiod` was not
  restarted. The installed driver is untouched, at the same SHA-256 as when I found it.
- **I did not verify the backup restores.** I verified it is byte-identical and that its
  signature validates. I did not copy it back over the original — doing so would mean
  deleting the working driver, which is exactly the risk I was asked to avoid.
- **I did not test the newer `632b5fe` build in place** — see above, that's a founder call.
- **I did not verify the ad-hoc-vs-quarantine claim empirically.** I did not build a
  signed DMG containing the plugin and try to load it on a clean Mac. The reasoning is
  standard Gatekeeper behaviour and the ad-hoc signature is confirmed, but the end-to-end
  failure has not been reproduced here.
- **I have not read `scripts/verification/README.md`** — it does not exist in this repo at
  any commit I can see. See the staleness note below.

---

## Why the denoiser may sound "nowhere near Krisp"

The founder's verdict on 2026-09-17: *"That denoiser doesn't work really well — nowhere
near [Krisp], the real denoiser that is running perfectly on this machine."* That directly
contradicts this repo's own README, which claims the locked config *"tied or beat Krisp on
measured noise floor and voice/noise ratio"* in a same-mic simultaneous-capture A/B.

When a documented benchmark and the user's ears disagree, the benchmark is the thing to
doubt. Here is what was actually measured, and what was only reasoned about.

### Ruled OUT: the silent-fallback hypothesis

`michelper` has a fail-safe that disables denoising for the whole run — silently, as far
as a user is concerned — if the model can't be loaded, the mic isn't at 48 kHz, or
`SALESOS_DENOISE_DISABLE` is set. "The denoiser sounds bad" and "the denoiser never ran"
produce the same symptom, so this had to be eliminated first.

**It is eliminated.** Running `./build/michelper` live:

```
Capturing from: MacBook Pro Microphone
Mic format: 48000 Hz, 1 ch -> ring: 44100 Hz, 2 ch, int16
Denoiser: DeepFilterNet3 STANDARD, post_filter_beta=0.08 (ENABLED)
  Frame size: 480 samples/hop (10.0ms @ 48kHz)
```

The denoiser is engaging, at full strength: `kAttenLimDb = 100.0f` (~unlimited
attenuation), `kPostFilterBeta = 0.08f`. Not throttled, not falling back.

### Suspect #1 — a pointless 48k → 44.1k → 48k double resample

Look at that banner line again: `48000 Hz, 1 ch -> ring: 44100 Hz, 2 ch`.

```
mic 48 kHz ──▶ DFN3 denoises at 48 kHz (its required rate)
            ──▶ AVAudioConverter resamples 48000 → 44100   ← conversion 1 (160:147)
            ──▶ ring / device publishes at 44100
            ──▶ Zoom / WhatsApp / Teams want 48000, so CoreAudio
                resamples 44100 → 48000                     ← conversion 2 (147:160)
```

The source is 48 kHz. Every consumer is 48 kHz. DeepFilterNet itself is 48 kHz. And the
pipeline detours through 44.1 kHz in the middle, at a non-integer ratio, **twice**, for no
reason that appears anywhere in the source or README.

Confirmed from the live device list — ours is the only device on this machine not at 48 k:

```
MacBook Pro Microphone   rate=48000   DEFAULT-INPUT
krisp microphone         rate=48000
Sales OS Microphone      rate=44100   ← ours
```

**Krisp does not do this.** Its device runs at 48000.

This is not a novel theory — **this project already learned this exact lesson on the
Windows side and wrote it down.** `docs/windows-capture.md:105`:

> *"Hardcode 16000 Hz / 1ch / 16-bit, not the sample's 44100/2ch. VoIP is natively 16k or
> 48k mono; resampling up to 44.1k and back down for STT is two […]"*

The Mac virtual mic still does the thing the Windows capture path was explicitly designed
to avoid.

**The fix is small:** `kSampleRate` in `src/shared/AudioRing.hpp:61` from `44100` to
`48000`, which removes conversion 1 entirely and lets conversion 2 disappear on its own.
Mono→stereo duplication stays.

**Why it is safe to attempt:** the ring header carries `sampleRate`, and `RingReader`
rejects a segment whose rate doesn't match the compiled constant
(`AudioRing.hpp:407-411` → `OpenError::FormatMismatch`), which the driver turns into
**silence**, not garbage. So a half-updated install (new helper, old driver, or vice
versa) fails audibly-silent rather than producing corrupted audio. Both binaries must be
rebuilt and installed together.

### Suspect #2 — the installed driver is missing the real-time-safety fix

Covered above under [two builds](#there-are-two-builds-and-they-are-not-the-same), but it
belongs here too, because it is a **quality** bug and not only a correctness one.

The installed driver (`9b27dd2`) calls `shm_open`/`fstat`/`mmap`/`munmap` **on
coreaudiod's real-time IO thread**. The commit that fixes it (`632b5fe`, built but never
installed) says it plainly:

> *"Any blocking syscall on an RT audio thread risks an audible glitch, and live denoising
> now adds real per-callback CPU work on the writer side, leaving less headroom to absorb
> one."*

An RT-thread stall does not sound like weak noise suppression — it sounds like clicks,
dropouts, and roughness. A listener comparing against Krisp would reasonably summarise
that as *"nowhere near as good"* without it being a denoising-strength problem at all.

**The fixed binary already exists on disk and has never been installed.** This was
declined on 2026-09-17, but it was declined framed as "an RT-safety fix" — worth
re-deciding now that it is a candidate cause of the quality complaint itself.

### Suspect #3 — DFN3 Standard really is weaker than Krisp

Possible. But before swapping models, **re-run the A/B the README rests on** — the
tooling is already in the repo (`phase2/dfn_wavtest`, `phase2/bench/capture_fair.sh`,
`phase2/bench/tonetest.sh`). That benchmark's conclusion is the thing in dispute; a model
swap is a large, uncertain piece of work to start on the strength of a benchmark nobody
currently believes.

Note the order matters: suspects 1 and 2 degrade audio *after* denoising. If they are
live, any re-run of the A/B through the live pipeline is measuring them, not the model.
`dfn_wavtest` bypasses both (file in, file out, no ring, no RT thread) and is therefore
the only fair way to judge the model itself.

### What I did NOT verify here

- **I have not listened to anything.** I cannot judge audio quality. Everything above is a
  set of *mechanisms that would degrade quality*, two of them concrete and cheap to test —
  not a confirmed cause.
- **I did not confirm audio actually reaches the ring.** `michelper`'s level meter read
  `0.000` for most of the 6-second run (one `0.001`). That is consistent with a quiet
  room, but it is *also* consistent with TCC handing the process silence. I did not
  disambiguate — and a zero that might mean "the mechanism is missing" is exactly the trap
  this project has been burned by, so I am not claiming the capture path works.
- **I did not measure the resampling penalty.** The double conversion is confirmed to
  exist; its audible cost is reasoned, not measured.
- **I did not re-run the Krisp A/B.**

---

## What shipped on 2026-09-17

Two changes, both approved by the founder, both installed and verified.

### 1. Ring rate 44100 → 48000

`src/shared/AudioRing.hpp:61` in `salesos-virtualmic`. One functional line; the rest of
the diff is comments that would otherwise have become false. Everything else derives from
this constant (`Driver.cpp:133`, `kCapacityFrames`, michelper's `outFmt`, the test tools'
timing), so nothing else needed changing.

Verified, asserting the state **changed** rather than matched:

| | before | after |
|---|---|---|
| michelper banner | `48000 Hz, 1 ch -> ring: 44100 Hz` | `48000 Hz, 1 ch -> ring: 48000 Hz` |
| device rate (`system_profiler`) | 44100 | **48000** |
| michelper binary SHA | `7e8ef673…` | `c855ab86…` |
| driver binary SHA | `2e57b712…` | `7565102b…` |

The device now matches every other device on this machine, Krisp's included.

### 2. The RT-safety driver build, installed

The rebuild came off `632b5fe`, so the never-installed RT-safety fix shipped with the rate
change — they had to be rebuilt together anyway.

Installed via the app's own mechanism (`osascript … with administrator privileges`, the
same call as `virtualmic.ts:157`). Installed binary SHA matches the build exactly
(`7565102b…`), signature valid, ownership back to `root:wheel`.

`rtsafetytest`: **PASS** — structural check confirms no `shm_open`/`mmap`/`munmap`/`fstat`
in `Pull()`/`ReadContinuous()`; behavioural check over 5 writer restart cycles gave
`calls=463 avg=1.92us max=56.38us overBudget(>150us)=0`.

### Red-check of the format guard (a real one, not a synthetic one)

Between rebuilding the helper and installing the matching driver, the machine was in a
genuine mismatch: a 48 kHz writer against the still-44.1 kHz installed driver. That is
exactly the half-updated state the `FormatMismatch` guard exists for, so it was used as
the red check.

```
RED   (48k writer, 44.1k driver, loud audio playing):
      callbacks=517 samples=529408 maxAbs=0.00000 verdict: SILENCE
GREEN (48k writer, 48k driver, same harness, same audio):
      callbacks=562 samples=575488 maxAbs=0.59723 verdict: <see below>
```

Silence under deliberately loud audio, then real signal after the matching install. The
guard does what the header claims: a half-updated install goes silent, never garbage.

---

## RETRACTED: the "measurable discontinuities" finding, and the claim about `underruntest`

An earlier version of this section reported that the pipe had measurable discontinuities and that
`underruntest` was structurally blind to them. **Both claims were wrong, and both were mine, not the
product's.** They are kept here as a correction rather than deleted, because the failures are more
useful than the non-finding was.

The full write-up lives in `scripts/verification/README.md` under
*"AUDIO INSTRUMENTS — four failures in one session"*.

### Retraction 1 — "underruntest is blind to frame repetition"

Claimed, from the tool's own description of itself as a dropout counter:

> ~~"The project's dropout detector is structurally blind to frame repetition."~~
> ~~"A clean underruntest run is not evidence of a clean pipe."~~

Reading `ReadContinuous()` disproves it in about a minute:

```cpp
CopyFramesFrom(m, readCursor_, dst, frameCount);
readCursor_ += frameCount;      // every Ok cycle, exactly frameCount, always
```

The cursor advances by exactly `frameCount` on every `Ok`. The only other thing that moves it is a
resync, and a resync is only ever reached **through** a non-Ok cycle — which `underruntest` counts.
Zero non-Ok genuinely does imply zero repetition. The guarantee was real; it was only *implicit*.

This mattered: the founder had already approved that second sentence for the verification README. It
came within one edit of being enshrined as a rule teaching future sessions to distrust a working tool.

**Fixed rather than just documented** (`salesos-virtualmic` `4f19e3d`): `underruntest` now measures
cursor advance every cycle and prints continuity unconditionally, including the zero case. Its
headline verdict now reads both failure modes — it previously printed `PERFECT: zero dropouts` on a
100%-discontinuous stream. Red-checked in both directions, file restored byte-identically by SHA.

### Retraction 2 — the discontinuity measurement itself

One recording of a known 440 Hz tone produced a result that looked diagnostic:

```
maxAbs = 0.24411   maxAdjDelta = 0.14346 (vs 0.01406 theoretical)   freq = 432.6 Hz
```

Two clean re-runs of the identical command:

```
run 1:  maxAbs = 0.00189   freq = 19554.6 Hz   near-zero = 94.69%
run 2:  maxAbs = 0.28152   freq = 11896.3 Hz   near-zero = 70.27%
```

19 kHz and 11 kHz for a 440 Hz tone are nonsense — the recordings were 70–95% silence. The harness
never sequenced `tonehelper`'s priming against `recordwav`'s start, so each run captured a different
arbitrary slice of startup. All three runs were noise; the first merely looked like an answer.

### What the pipe actually measures as, with a working instrument

`underruntest` against a live writer, post-fix, reported directly by the tool:

```
cycles=468 (5s)
  Ok        468 (100.0%)
longest consecutive non-Ok streak: 0 cycles (~0.0ms)
continuity (within streaming runs): 0 discontinuities, 0 frames repeated, 0 frames skipped
PERFECT: zero dropouts, stream continuous
```

Strictly contiguous. **There is no open discontinuity issue** — the measurement that suggested one
was a harness artifact.

**What the founder has and has not confirmed, stated precisely** (an earlier version of this doc,
and the commit message that introduced it, overstated this — corrected here):

- **Confirmed:** `michelper` runs, the level bar moves (which independently closes the TCC /
  "is the mic actually captured" question), and a Voice Memos recording with **Sales OS
  Microphone** as the input came out clean.
- **NOT yet confirmed:** the A/B against Krisp. At time of writing the founder is running it, and
  will report on three specific things — is the noise gone, does the voice sound natural, are there
  clicks or roughness.

So "the 48 kHz fix plus the RT-safety build resolved the quality complaint" is the **working
conclusion**, supported by one clean Voice Memos recording. It is not yet a verified comparison
against the reference the complaint was made against.

---

## Scoped and deferred: the output ("speaker") device

Krisp ships a **pair** — `krisp microphone` (input) and `krisp speaker` (output). CallRise
ships only the input device.

**Deferred, deliberately, with the reason recorded:** it is a second bundle to build, sign,
notarize, install and uninstall, and the *first* device is not shipping to anyone yet.

**It is not needed for buyer capture.** That was the open question, and the answer is no:
`src/main/loopback.ts:181` gates buyer capture on `darwin || win32`, and the file's header
states `audio: 'loopback'` is *"genuinely cross-platform (WASAPI loopback on Windows,
ScreenCaptureKit-backed loopback on macOS)"*. Mac captures the buyer through whole-system
loopback today, the same path Windows uses.

What an output device would buy later is **per-app isolation**. `src/main/diagnose.ts:48`
is candid that the current path is whole-system and that claiming "process loopback" would
be dishonest — which is why the M12 limitation (close other audio, wear headphones) still
stands on Mac. That is a quality-of-life fix, not an enablement one.

*Verified by reading the 1.13.0 source only.* Mac buyer capture has **not** been exercised
at runtime here — that needs a real call, and macOS Screen Recording permission
(`loopback.ts:116` ships a settings deep-link for when it is missing).

---

## The macOS floor — declared 12.0, built against 12.0, never executed on 12.0

**Decided 2026-09-17 on reasoning, not measurement, and recorded as such:** there are no users yet,
only the founder's two machines, and the arm64-only build already excludes every Intel Mac — so
Big Sur (11) is a population of zero by construction. If real users later appear on older hardware,
the number was never checked against usage data because none existed.

What moved: all 8 `-mmacosx-version-min` flags in `build.sh`, 11.0 → 12.0, so the **linked**
binaries — the ones whose declared floor actually gates launch — now agree with the app's
`Info.plist` (`LSMinimumSystemVersion 12.0`):

```
driver     minos 11.0 → 12.0
michelper  minos 11.0 → 12.0
```

What did NOT move, and the founder's instruction assumed otherwise. `libdf.a` does not "inherit
26.0" — it is a **mix**, measured with `otool -l`:

```
326 objects @ 11.0   df, tract_*, regex*, tar, rustix   ← the project's own crates (cargo's to rebuild)
393 objects @ 26.0   compiler_builtins + prebuilt std   ← shipped precompiled with Homebrew's rustc
 31 objects @ 15.5   another prebuilt blob
```

Cleaning one crate and rebuilding with `MACOSX_DEPLOYMENT_TARGET=12.0` moved exactly **17** objects
— proving the mechanism works and bounding what it can reach. The other 424 are not cargo's; moving
them needs `-Z build-std` on nightly. `rustc --print deployment-target` says **11.0** for this
target, so the 26.0 stamps are an artifact of the machine Homebrew built its toolchain on, not a
Rust requirement. `libdf.a` was **restored byte-identical** to the verified backup rather than
left half-converted — a partially converted static lib is worse than either state.

Verified after the rebuild: `kSampleRate` still 48000, `rtsafetytest` PASS (max 35 µs, 0 over
budget), `underruntest` 562/562 Ok with 0 discontinuities once the writer is primed first (an
intermediate 7.2 % stale reading was the harness starting the reader before the writer — not a
regression), signature valid, still arm64.

**It stays open.** The project's rule asks for a floor that is both *built against* and *run
against*, and only the first is met — no macOS 12 machine or VM exists here. Do not let the numbers
agreeing read as the floor being tested.

---

## Still open, carried forward

1. **Uninstall gap** — `installDriver()` with no `uninstallDriver()`. Dragging the app to
   the Trash leaves an orphaned audio driver. Stage 2, not shippable without it.
2. **Ad-hoc signature** — needs Developer ID + notarization before it can load from a
   downloaded DMG. Membership exists; the wiring does not.
3. **arm64-only** — no Intel slice, for the driver, `michelper`, or `libdf.a`.
4. **The macOS floor is claimed, not established** — `build.sh` targets
   `-mmacosx-version-min=11.0`, but linking `libdf.a` emits warnings that its objects were
   *"built for newer 'macOS' version (26.0) than being linked (11.0)"*. So `michelper` may
   not run on macOS 11 at all. Pre-existing, unrelated to this session's changes.

   **This matters for the Stage 3 arm64-vs-universal decision specifically:** a floor that
   is claimed but not real means a user on an older macOS gets a **crash**, not a clean
   refusal to install. Whatever minimum the release declares has to be one that was
   actually built and tested against, not one inherited from a flag nobody verified.

5. ~~The discontinuity, pending a baseline~~ — **retracted, not carried.** See
   [the retraction](#retracted-the-measurable-discontinuities-finding-and-the-claim-about-underruntest).
   There is no open issue here; the measurement was a harness artifact.

---

## Related: this checkout was 841 commits stale — now fixed

On arrival this Mac's working tree was at `d4ba993` / `package.json 0.1.0` (2026-07-28),
while `origin/main` was at `a8bfc35 "Bump to 1.13.0"` — **841 commits behind**, with
`sqlite-vec`, Sales Brain, Rise chat and `scripts/verification/` all absent. Any audit run
against that tree would have been auditing the wrong codebase.

Fast-forwarded on 2026-09-17 with founder approval. Verified beforehand that local `main`
was an ancestor of `origin/main` (`git merge-base --is-ancestor`) and 0 commits ahead, so
no local work could be lost. Now at `a8bfc35` / `1.13.0`, and `scripts/verification/`
(103 entries, 80 KB README) is present.

`src/main/virtualmic.ts` came through the 841 commits **unchanged** — same blob
`6759100` before and after.
