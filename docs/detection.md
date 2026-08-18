# Ambient call detection

Multi-signal, multi-platform detection of an in-progress call, feature-flagged
off by default (`detection.enabled` in Settings). Core pieces:

- `src/main/detection/types.ts` — every tunable number (`DETECTION_TUNING`),
  signal kinds, FSM state shape.
- `src/main/detection/fusion.ts` — pure: raw signals → one confidence score
  per app/pid group, within a rolling 10s window.
- `src/main/detection/stateMachine.ts` — pure FSM (idle → candidate →
  detected → capturing, with switch/pending states).
- `src/main/detection/policy.ts` — pure: a fused candidate → a capture
  decision (ask / full / mic-only / ignore). Already fully registry-agnostic
  — never imports `appRegistry`, treats `appId` as an opaque string.
- `src/main/detection/appRegistry.ts` — the ONLY place that knows about
  specific apps (bundle ids, exe names, title patterns) — a data file, not
  detection logic.
- `src/main/detection/adapters/{Mac,Windows}Adapter.ts` — the only
  platform-specific code; both wrap a native addon
  (`native/mac-audio-activity`, `native/win-audio-sessions`) behind the same
  `ICallDetectorAdapter` contract, and both lazy-load that addon (only on
  first `isSupported()`/`start()`, never in the constructor — a broken addon
  must never be able to crash the whole app on every launch).

## Detecting apps with no registry entry (M17 §2.2)

**As of 2026-07-28, an app does NOT need a registry entry in `appRegistry.ts`
to be detected.** This was not true before — three of the four signal-emission
points in each adapter used to hard-gate on `identity.known`, meaning an
unlisted app could structurally never cross `startThreshold` (0.6) no matter
what it did. Fixed by:

1. **`process` signals** — now emitted for every running app (own-process
   excluded), not just known ones. Weight is only 0.1, far too weak to matter
   alone; the registry now only affects which OTHER signals get the "known"
   bonus, never whether a `process` signal exists at all.
2. **`mic-session` signals** — already emitted for unknown apps before this
   change, just at a lower weight (`mic-session-unknown`). That weight was
   raised from 0.25 → 0.35 (see `types.ts`'s `weights` comment) specifically
   so it can combine with one weak corroborating signal to cross threshold —
   previously it structurally couldn't (0.25 + process 0.1 + window-title 0.2
   = 0.55, always short of 0.6).
3. **`window-title` signals** — `appRegistry.ts`'s new `looksLikeCallTitle()`
   is a conservative, explicit-words-only fallback (`call`, `meeting`,
   `conference`, `huddle`, `webinar`, `voip`, `dialer`, "on a call", "in a
   meeting" — deliberately NOT a bare elapsed-timer pattern, too
   false-positive-prone) used only when `matchTitle()` (the per-app registry
   patterns) finds nothing. Weighted lower than a known-app title match
   (`window-title-generic`: 0.15 vs `window-title-known`: 0.2) since it's
   heuristic, not an exact pattern for a specific real app.

Net result: an unrecognized app with an active mic session, a running
process, AND a call-sounding window title reaches ~0.60 confidence (mic 0.35
+ process 0.1 + title 0.15) — right at threshold. **An unknown app with a mic
session but NO identifiable call-sounding window title still will not be
detected** (0.35 + 0.1 = 0.45, short of 0.6) — this is a deliberate,
conservative choice, not a bug: without title corroboration there isn't
enough signal to distinguish a real call from a dictation app / voice memo /
other mic-using background process. Closing that gap needs a stronger
generic signal — bidirectional audio detection (mic + speaker output from the
same process simultaneously) or network-flow correlation (sustained RTP/WebRTC-range
UDP alongside mic use) — both **not yet implemented**; see "Not yet done"
below.

Regression tests: `src/main/detection/__tests__/fusion.test.ts` ("an unknown
app crosses the start threshold once mic-session, process, and a generic
call-sounding title all corroborate") and
`src/main/detection/__tests__/appRegistry.test.ts`.

## Not yet done (real gaps, not implemented as of this write-up)

- **Learn/correct flow** — asking "was that a call?" after an unknown app is
  captured, or offering one-click "stop detecting this app" on a misfire.
  Nothing built yet; every capture decision today is a one-shot ask/full/
  mic-only/ignore from `policy.ts`, with no per-app memory beyond the
  existing Settings → Detection app-override list (which still requires the
  user to add an entry manually, not something the app offers automatically
  post-call).
- **OS-derived name/icon for unknown apps** — the popup UI (`DetectionOverlay.tsx`)
  shows whatever `displayName` a signal carries, which for an unrecognized
  app is currently just its raw process/exe name (`normalizeAppIdentity`'s
  fallback), not a real icon or a nicely-cased display name pulled from the
  OS (macOS `CFBundleDisplayName`/`.icns`, Windows exe version-resource
  `FileDescription`/embedded icon).
- **Windows registry-based detection (as a zero-native-code alternative)** —
  Windows detection today still depends on `native/win-audio-sessions`
  (compiled C++/WASAPI). The `ConsentStore` registry-key approach (reading
  `HKCU\...\CapabilityAccessManager\ConsentStore\microphone\...` for
  `LastUsedTimeStop == 0`) was proposed as a way to detect mic-in-use with
  zero compiled code, but is unexplored/unverified — the native addon path
  remains the only implemented one.
- **Bidirectional-audio and network-flow-correlation signals** — described
  above as the way to close the "unknown app, no title corroboration" gap.
  Neither signal kind exists in `DetectionSignalKind` yet.
- **Per-source `SourceEventAdapter` extension point** (for a future
  authoritative-event integration, e.g. a dialer's own webhook/API) — not
  started.

## The overlay's visual/interaction design (M17 Phase 3)

`src/renderer/src/features/detection/DetectionOverlay.tsx` (renderer) +
`src/main/detection-overlay.ts` (the window). Redesigned as a glass HUD
capsule — see the earlier commit for the base treatment. On top of that,
Phase 3 added:

- **Pre-created at boot** (`initOverlay()`, called from
  `detection-service.ts`'s `startDetectionService()`, unconditionally,
  regardless of whether the feature is enabled) instead of lazily on first
  `showOverlay()` — window creation + first content load is far slower than
  the <100ms show budget on its own.
- **Native translucent material** — `vibrancy: 'under-window'` on macOS only.
  *(M27 docs audit, 2026-08-14: this used to also claim `backgroundMaterial:
  'acrylic'` on Windows. That WAS tried and then **reverted** — confirmed on
  real Windows hardware, it painted an OS-compositor backdrop that ignored the
  card's own rounded-corner CSS, showing through as an ugly square behind it
  (BUG-006). Windows now relies solely on the CSS `backdrop-blur`; see
  `detection-overlay.ts`'s own comment. Corrected here so nobody re-attempts
  acrylic believing it already works.)*
- **Shadow room** — the window is 16px larger than the visible card in each
  dimension (`CARD_INSET` in `detection-overlay.ts` — the doc previously said
  32px; the shipped value is 16), with matching
  transparent padding in `OverlayShell` — without this the card's own drop
  shadow was clipped flush at the window's edge and simply didn't render.
- **Source identity as the hero element** — `SourceMonogram` (a
  colour-hashed 2-letter monogram, deterministic per `appId`) +
  `SourceNameChip` (an uppercase pill). This is the ONLY identity tier
  implemented — no real per-app logos, no OS-extracted icons (both would
  slot in ahead of the monogram in the same resolution order; icon
  extraction needs native code, not started). Applied uniformly, so an
  app with no registry entry looks exactly as finished as one that has one.
- **"Not a call"** — a one-click quick action on the capturing card
  (blocklists the app via the same `appOverrides: 'never'` mechanism the
  toast/switch states' "Never for X" links already used, then stops the
  capture) — the release valve for how permissive Phase 2's detection now is.
- **Auto-dismiss countdown** — a thin linear bar (reusing the existing
  `.cue-countdown` CSS utility, not a literal ring around the button as
  originally sketched) on the toast/switch-prompt states, timed to match
  `DETECTION_TUNING.detectionToastTimeoutMs`/`switchPromptTimeoutMs`
  (duplicated as constants in the renderer file with a keep-in-sync comment
  — it can't import from `src/main`).
- **Global shortcuts** — Cmd/Ctrl+Shift+S (stop) / Cmd/Ctrl+Shift+P
  (pause/resume), registered only while the feature is enabled (same
  zero-footprint-when-off rule the tray already followed), with a graceful
  no-op (logged, not thrown) if another app already holds the combo.
- **Right-click context menu** on the overlay window itself — Open CallRise
  AI / Pause-or-Resume / Snooze 1h, reusing the exact same `trayActions`
  object the tray menu already used (no new action plumbing).

### Explicitly NOT done in Phase 3 (real gaps, not silently skipped)

- **Live audio meter** (spec: a 60fps canvas waveform) — no audio-level data
  is piped from the actual recording graph (`LiveView`'s audio pipeline) to
  this separate overlay window at all; building that pipe (new IPC channel +
  sampling) wasn't attempted. The pulsing `LiveDot` remains the only "it's
  live" motion.
- **Collapsed pill mode** (a 132×36 compact state, auto-collapsing after
  idle) — not implemented; the card is always shown at full size.
- **Learn/correct flow UI** ("Keep capturing calls from X?" after a
  successful unknown-app capture) — this needs a per-app "seen/auto/always/
  never" history model that Phase 2 didn't build; a UI without that backing
  data would be hollow, so neither was attempted.
- **Screenshot verification across every state, light + dark** — not
  possible from this environment (no way to run the packaged app's GUI and
  trigger a real detected call here); verified by typecheck/lint/existing
  test suite + careful code review only. Treat this UI as code-reviewed, not
  visually confirmed, until someone actually looks at it running.

## Adding a known app to the registry

Add an entry to `CONFERENCING_APPS` in `appRegistry.ts` — `appId`,
`displayName`, and whichever of `macBundleIds` / `windowsExeNames` /
`processNames` / `titlePatterns` you can supply (not all are required; a
browser-hosted app like Google Meet only needs `titlePatterns`, since the
browser process itself has no dedicated bundle id/exe name for that specific
service). This is purely additive — it never gates whether an app CAN be
detected (see above), only how confidently and how it's labeled.
