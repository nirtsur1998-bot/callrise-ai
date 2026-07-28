# Windows buyer-side capture

Status: **design + auto-switch policy landed; the native addon is not built.**
See "Where this stands" at the bottom for exactly what exists and what does not.

## The bug this is fixing

The previous session concluded that Windows "routes VoIP audio through a
separate Communications role that whole-system WASAPI loopback doesn't
include", and that buyer capture was therefore blocked by an OS limitation.

That is wrong, and the distinction matters. Microsoft's
[Loopback Recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)
documentation is explicit that a loopback stream carries "the mix of all audio
being played" — communications streams are not filtered out of it.

The real cause is that **we open the wrong endpoint.** Windows keeps separate
default render endpoints per _role_:

| Role                       | Who asks for it                               |
| -------------------------- | --------------------------------------------- |
| `eConsole` / `eMultimedia` | media apps, and every loopback recorder       |
| `eCommunications`          | VoIP apps — Teams, Zoom, WhatsApp, softphones |

The single most common headset setup — headset as **Default Communication
Device**, speakers as **Default Device** — makes those two different physical
devices. The call plays to the headset. Our capture opens the speakers. We
record silence.

The diagnostic tell matches the original symptom report exactly: **the ringtone
was captured but the call was not.** Ringtones render to `eConsole`; the call
renders to `eCommunications`.

## Two paths, because neither one is enough

### Primary: per-process loopback

`ActivateAudioInterfaceAsync` with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`.

Endpoint-agnostic — it captures a _process_, not a device — so the entire
wrong-endpoint problem above simply does not arise. This is the right primary.

### Fallback: device loopback — mandatory, not optional

There is a documented, reproducible, **still-open** Microsoft bug:
per-process loopback captures **silence from Microsoft Teams**
([Windows-classic-samples#414](https://github.com/microsoft/Windows-classic-samples/issues/414),
confirmed open as of December 2025). Teams uniquely runs _two_ render sessions
on the same device, both showing non-zero meter levels, and process loopback
records silence regardless. Both `INCLUDE` and `EXCLUDE` tree modes fail. The
root cause has never been identified. Device loopback captures Teams fine.

Teams is a named requirement, so a single capture path cannot ship.

The fallback must also solve the original endpoint problem itself:

- enumerate **all active render endpoints**, explicitly including the
  `eCommunications` role endpoint, and mix them;
- implement `IMMNotificationClient::OnDefaultDeviceChanged`, because VoIP apps
  switch endpoints mid-call the moment a headset is plugged in.

## Choosing between them automatically

Commercial vendors did not solve this. StreamVox ships a manual "use only if
Teams/Zoom is silent" toggle — which asks the user to diagnose an audio-stack
bug. We can do better, because Windows answers two questions at once:

| Question                    | Source                                  |
| --------------------------- | --------------------------------------- |
| Is the app producing sound? | `IAudioMeterInformation` peak, non-zero |
| Are we receiving any of it? | RMS of the PCM we actually got, zero    |

**Both true together is not a quiet meeting — it is a broken capture path.** It
is the only signal that separates the two, and it is exactly the measurement
the session-health liveness probe already makes (audio arriving that is pure
digital silence). There it is a symptom to surface; here it is a decision to
act on.

Implemented in `src/main/windows-capture/switch-policy.ts`:

- silence + a live meter, sustained **2s** → switch to device loopback and log
  why, with the peak value in the message;
- any real audio, or the app going quiet, clears the suspicion;
- an **unreadable meter never switches** — absence of evidence is not evidence
  of absence, and treating `null` as "playing" would send every quiet call to
  the fallback;
- **one-way.** Device loopback captures everything process loopback does, so a
  return trip buys nothing and risks oscillating between paths mid-call, which
  is worse than the bug being worked around.

Unit-tested (12 cases), including the Teams shape and the quiet-meeting
false-positive it must not trigger on.

## Implementation notes for the addon

Hard-won details that cost days if missed:

- **Do not gate on a Windows version number.** The documented minimum is build
  20348, but the functionality was serviced back into 2004+ via cumulative
  updates. Call the API and check the `HRESULT` at runtime; a version check
  both false-positives and false-negatives.
- **`GetMixFormat` and `IsFormatSupported` return `E_NOTIMPL` by design** — the
  interface points at `AudioSes!CMixerClient`, which does not implement them.
  The `WAVEFORMATEX` must be hardcoded.
- **Hardcode 16000 Hz / 1ch / 16-bit**, not the sample's 44100/2ch. VoIP is
  natively 16k or 48k mono; resampling up to 44.1k and back down for STT is two
  conversions and audibly worse. `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM` is
  load-bearing and makes this work regardless of the app's native rate.
- `Initialize` with `AUDCLNT_SHAREMODE_SHARED`, flags
  `LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM`, `hnsBufferDuration = 0`.
- **`GetBufferSize()` returns 0 — do not trust it.** Size buffers from
  `GetNextPacketSize() × nBlockAlign`. Trusting it yields buffers of zeros
  and 255s.
- `GetActivateResult` returns only `IAudioClient`, not `IAudioClient2`/`3`. No
  `SetClientProperties`, no low-latency shared-mode periods.
- `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK` is a **string constant**
  (`L"VAD\\Process_Loopback"`) passed where a device ID goes — not a real
  endpoint.
- **Threading:** own thread with `CoInitializeEx(nullptr, COINIT_MULTITHREADED)`.
  Electron's main thread is STA. The completion handler is invoked on an MTA
  worker thread and must be agile — implement `IAgileObject` (hand-rolled is
  sufficient; WIL is not required).
- **Activation is async and the return value is not the result.**
  `ActivateAudioInterfaceAsync` returns `S_OK` immediately; the real `HRESULT`
  arrives via `GetActivateResult` in the callback. Wait on an event.
- Release `IActivateAudioInterfaceAsyncOperation` after completion, and do not
  free the handler before the callback fires. Both are documented leak sources.
- `AvSetMmThreadCharacteristics(L"Audio")` (MMCSS) on the capture thread, or
  you get dropouts under load.

### Keep a silent playback stream open

For the lifetime of every capture session, unconditionally. WASAPI loopback
produces **no data at all** when nothing is playing — the callback never fires,
reads block, and the stream still reports active. A quiet meeting then becomes
indistinguishable from dead capture, and trips Deepgram's 10s NET-0001
deadline. The cost is negligible and it removes an entire class of
unreproducible bug report.

## Shipping without a compiler

`prebuildify --napi` + `node-gyp-build`: one binary per platform/arch, valid
across all Node **and** Electron versions, because N-API is ABI-stable. No
`electron-rebuild`, no per-ABI matrix. This single choice is the difference
between a 5-day addon and a 3-week one.

This cannot be cross-compiled from macOS or Linux. The Windows binary is built
on GitHub Actions `windows-latest` and the prebuild committed or attached to
the release. That is also the permanent answer to the USB-stick workflow: CI
builds the binary, so a Windows tester installs rather than compiles.

## Evaluating `WerdoxDev/loopback-capture` (§3.1)

Assessed before writing anything. It is a real, relevant package — published as
`loopback-capture` (renamed from `application-loopback`), MIT, an N-API port of
Microsoft's own WASAPI process-loopback sample.

**What it gives us**

- Both paths already: `start(processId, includeProcessTree, cb)` for
  per-process, `startSystemAudio(cb)` for device loopback.
- Declares `napi_versions: [9]` — ABI-stable, so one binary spans Node and
  Electron exactly as §3.5 wants, via a different route than prebuildify.
- Ships `build/Release/*.node` in the published tarball, so the common case
  needs no compiler.
- MIT, so vendoring or forking is unproblematic.

**What it does not give us — and these are the requirements, not extras**

1. **No endpoint or role selection.** `startSystemAudio(callback)` takes no
   device argument, so it cannot be pointed at the `eCommunications` endpoint.
   That is the _entire bug_ from Correction 1. The fallback path would still
   record silence in the headset-as-communications-device setup.
2. **No Teams workaround and no auto-switch** — §3.4 would still be ours.
3. **No `IMMNotificationClient`**, so a mid-call headset plug-in still loses
   audio.
4. **Hardcoded 48kHz stereo**, where we want 16kHz mono for STT.
5. Single maintainer, ~24 commits, 10 stars, `cmake-js` as a _runtime_
   dependency (so a prebuild miss drags in a CMake toolchain requirement).

**Assessment:** it does not collapse days 1–2, because the parts it provides
are the easy parts. Every item that made this milestone hard — the
communications endpoint, the Teams fallback, device-change handling, the STT
audio format — is absent. Its genuine value is as a **reference
implementation**: an N-API port of the Microsoft sample with the activation
dance already worked out, under a licence that lets us read and borrow freely.
Recommendation: **use it as reference, write our own addon.**

## The finding that changes Phase 3's shape

Adopting native capture on Windows moves buyer audio from the **renderer** to
the **main process**, and that has a consequence the spec does not account for.

Today (macOS, and the current unverified Windows path) both sides go through
one Web Audio graph:

```
mic  ──► MediaStreamSource ─┐
                            ├─► ChannelMergerNode ─► worklet ─► interleaved stereo
loopback ► MediaStreamSource┘
```

One `AudioContext` means Chromium resamples both sources onto a single clock
and keeps them sample-aligned. That is why M12 chose it, and why the drift
meter in `session-health` deliberately does not implement a PI resampler.

A native addon delivers buyer PCM to the **main process** on its own clock,
while the mic stays in the renderer on Chromium's. Merging them means
reconciling **two independent clock domains** — a jitter buffer plus real drift
correction, i.e. exactly the machinery §1.5 argued was unnecessary. It becomes
necessary the moment the two sides stop sharing a context.

So the honest scoping is that per-process loopback is not only "the API plus a
fallback path". It is:

1. the addon (per-process + device loopback + endpoint enumeration + device
   change), and
2. a cross-process audio join with drift correction, and
3. a Windows capture path that is structurally different from the macOS one,
   which doubles the surface that has to be tested on real hardware.

Item 2 is not in the original estimate and is the risky part — it reintroduces
the sync problem the current architecture was designed to avoid.

## Where this stands

**Landed and tested**

- `switch-policy.ts` — the auto-switch heuristic, 12 unit tests, no native code.
- This document, including the §3.1 evaluation above.
- `buyer-silence.ts` — a zero-native-code mitigation for the exact symptom
  this bug produces (see below). Shipping today, on every existing install,
  while the addon stays blocked.

**Not built**

- The native addon (per-process + device loopback, endpoint enumeration,
  `IMMNotificationClient`, MMCSS, silent-playback keepalive).
- `prebuildify`/`node-gyp-build` migration and the CI prebuild job.
- The cross-process audio join described above.

**Why:** the addon cannot be compiled or tested from a Linux container, and it
cannot reach the Windows CI runner either while pushes to the repository are
rejected with 403. Writing several hundred lines of untestable, unbuildable
COM code in that state would produce a deliverable whose only honest
description is "unverified". The decisions above are the ones worth locking in
first, and they are the ones that survive whichever way the addon is built.

Note that this repo already ships one small native addon
(`native/win-audio-sessions`, ambient call detection) with a working CI build
step (`npm run native:build:win`, wired into `build-windows-demo.yml`). That
addon does not help here — it reads session-level meter/activity data, not
audio — but it is the proof that this repo's CI pipeline CAN build and package
a Windows native addon once it can reach it. The blocker is exclusively repo
write access, not anything about the toolchain.

## Zero-native-code mitigation: `buyer-silence.ts`

While the addon is blocked, the bug's SYMPTOM is fully detectable without any
native code, and that is enough to turn an unexplainable failure into a
one-step fix.

The tell: on the existing (shipped, not addon-based) capture path, a rep whose
headset is the Default Communication Device but not the Default Device will
have a mic that carries real speech — they are clearly on a call — while the
buyer channel is bit-exact digital silence for the whole thing. That shape
does not happen in an ordinarily quiet moment; nobody sits through a live
sales call in total silence on both sides.

`BuyerSilenceWatcher` (`src/main/windows-capture/buyer-silence.ts`) watches
for exactly that: mic speaking at least 15% of a 45-second window while the
buyer channel stays silent throughout. It fires once per call (never
re-nagging), and the Live view shows a banner with a one-click deep-link to
Windows's sound settings (`loopback:openWindowsSoundSettings` →
`ms-settings:sound`) — the actual fix is setting the same physical device as
both Default Device and Default Communication Device.

This is not a substitute for the addon — it cannot recover the audio, only
point at the fix — but it means no Windows rep has to file a bug report
that reads as "the buyer side just doesn't work" before this ships.
