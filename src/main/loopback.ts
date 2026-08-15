// Lets the renderer's getDisplayMedia() receive system-audio loopback — the
// other party's voice coming through the rep's headphones/output (M12).
// Electron's `audio: 'loopback'` response is genuinely cross-platform (WASAPI
// loopback on Windows, ScreenCaptureKit-backed loopback on macOS) - only
// Linux has no supported path here, so this gates on darwin/win32.
//
// KNOWN WINDOWS LIMITATION (verified on real hardware; M21 Phase D re-confirmed
// it is still open). "Cross-platform" above is true for ORDINARY media playback
// only. On Windows a real VoIP call (tested: WhatsApp) does NOT reliably reach
// the Buyer channel: whole-system WASAPI loopback — what `audio: 'loopback'`
// taps here — doesn't reliably include audio that Windows routes through its
// separate "Communications" role. What does come through is physical mic bleed
// (the buyer's voice out of the speakers, picked up by the mic), which lands on
// the REP's channel and is therefore mislabelled as the rep.
//
// This is an OS/Chromium-level constraint, not a bug in this file — nothing
// here can fix it. Proper support needs a native addon using Windows'
// per-process Application Loopback Capture API
// (ActivateAudioInterfaceAsync + AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK),
// which does not exist in this repo. Deliberately out of scope for M21;
// documented here rather than only in CLAUDE.md so the next person reading
// this code sees it before trusting the "cross-platform" line above.
//
// Consent backstop: capture is DENIED unless the renderer has "armed" it first.
// The renderer arms exactly one request, synchronously, immediately before each
// getDisplayMedia call — and only after consent has been recorded. The handler
// consumes the arm (one grant per arm) and rejects any un-armed request. This is
// the main-process guard for "no consent = no capture" on the CAPTURE path,
// mirroring the retention guard in calls-fs.ts. It complements — never replaces
// — the renderer-side consent checks.
//
// On top of that sits the Settings master switch (app-settings.ts,
// `allowOtherPartyRecording`). It is checked TWICE below — at arm time and
// again at the actual grant — so that even if a stale "armed" flag somehow
// survived a mid-session toggle-off, the grant is still refused. The switch
// can only ever make this gate STRICTER: when it's true (the default), every
// existing consent check below still applies unchanged.
import { ipcMain, session, desktopCapturer, shell } from 'electron'
import { loadAppSettings } from './app-settings'
import {
  clearActiveConsent,
  consentPermitsCapture,
  persistActiveConsent,
  readActiveConsent
} from './consent-gate'
import { recordConsent } from './live/live-transcript'

// One-shot: set true by 'loopback:arm', consumed the moment a request is granted.
let armed = false

export function registerLoopbackCapture(): void {
  // Deep-link to the OS's screen/system-audio recording permission pane so the
  // rep can grant the permission buyer capture needs (mirrors the mic settings
  // helper). Only macOS gates this behind a permission prompt; Windows has no
  // equivalent per-app screen-recording toggle, so there's nothing to open.
  ipcMain.handle('loopback:openScreenSettings', async () => {
    if (process.platform !== 'darwin') {
      return { ok: false as const, error: 'not applicable on this platform' }
    }
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    )
    return { ok: true as const }
  })

  // Deep-link to Windows's sound settings — the fix for the endpoint bug
  // (docs/windows-capture.md): a headset set as Default Communication Device
  // while speakers stay the Default Device sends the call to one and our
  // capture to the other. `transcription:buyerSilent` detects the symptom
  // with no native code; this is the one-step remedy it points at.
  ipcMain.handle('loopback:openWindowsSoundSettings', async () => {
    if (process.platform !== 'win32') {
      return { ok: false as const, error: 'not applicable on this platform' }
    }
    await shell.openExternal('ms-settings:sound')
    return { ok: true as const }
  })

  // Synchronous arm/disarm so the renderer can flip this in the same tick as the
  // click gesture, right before getDisplayMedia (an async IPC would race).
  // Write the consent for the call about to capture. Synchronous because the
  // renderer calls it inside the click that opens getDisplayMedia — an async
  // round-trip would spend the user activation the browser requires, and the
  // capture prompt would never appear.
  ipcMain.on('consent:persist', (event, payload: { sessionId: number; consent: unknown }) => {
    const sessionId = Number(payload?.sessionId)
    const ok = Number.isFinite(sessionId) ? persistActiveConsent(sessionId, payload?.consent) : false
    event.returnValue = ok
    // M26 Phase 4.2 — copy the grant into the call's own journal.
    //
    // Load-bearing, not bookkeeping: applyConsentRetention strips every
    // channel-tagged buyer segment from a call whose recordOtherParty isn't
    // true, so a recovered buyer-capture call without this would lose the
    // buyer's entire half at the moment of recovery, silently.
    //
    // Read BACK rather than passed through, so the journal stores the same
    // sanitized record the gate actually accepted — never the renderer's raw
    // payload, which could claim a permission the sanitizer just refused. And
    // it is a copy: active-consent.json is still cleared on every app start,
    // so a grant that outlives a crash still cannot authorise the next call.
    recordConsent(ok ? (readActiveConsent()?.consent ?? null) : null)
  })

  ipcMain.on('consent:clear', (event) => {
    clearActiveConsent()
    // Revocation is journaled too — the strip is keyed on the FINAL flag, so a
    // call that goes consented -> revoked must replay as revoked.
    recordConsent(null)
    event.returnValue = true
  })

  ipcMain.on('loopback:arm', (event) => {
    // Buyer capture rides on system-audio loopback, supported on macOS and
    // Windows (see the file header) — Linux has no capture path, so arming
    // is refused outright there. The master switch can only remove
    // capability: if it's off, refuse to arm at all, regardless of what the
    // renderer believes consent is.
    const platformSupported = process.platform === 'darwin' || process.platform === 'win32'
    // ...and the consent itself is read back FROM DISK, never taken from the
    // renderer's word for it. This is what makes the guarantee provable rather
    // than merely true: the record outlives the process that claims it.
    armed =
      platformSupported && loadAppSettings().allowOtherPartyRecording && consentPermitsCapture()
    event.returnValue = armed
  })
  ipcMain.on('loopback:disarm', (event) => {
    armed = false
    event.returnValue = true
  })

  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      // Re-checked here too (not just at arm time) so a toggle-off that lands
      // between arm and grant can't slip through on a stale armed flag.
      // Anything that changed in between — a toggle-off, a revoke, the call
      // ending — closes the gate, and a stale `armed` flag on its own can no
      // longer open it.
      //
      // 1.2.6 hotfix — the phrase "the record being cleared as the call
      // ended" used to appear here as an established fact. It was not one:
      // clearActiveConsent() ran at app start, on explicit revoke, and when
      // a grant was persisted as "off", but never at call end. So the grant
      // outlived its call, and this check — which asks whether ANY consent
      // exists, not whose — would honour it during the NEXT call. The
      // comment described the guarantee the code was relied upon to provide
      // while the code did not provide it. endCall() now genuinely clears
      // it, which is what makes this sentence true rather than aspirational.
      //
      // Still outstanding, deliberately: this check does not name the call it
      // means. Every AI path passes its id and binds; the audio path cannot
      // do that safely until consent is keyed on callId (1.3.0's E1) —
      // binding to sessionId here would refuse capture after an ordinary
      // mono<->multichannel restart, which mints a fresh session id mid-call.
      if (!armed || !loadAppSettings().allowOtherPartyRecording || !consentPermitsCapture()) {
        callback({}) // deny — not armed, switch off, or no persisted consent
        return
      }
      armed = false // consume: one grant per arm
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (sources.length === 0) {
            callback({})
            return
          }
          callback({ video: sources[0], audio: 'loopback' })
        })
        .catch(() => callback({}))
    },
    { useSystemPicker: false }
  )
}
