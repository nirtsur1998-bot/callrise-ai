// `--diagnose` (§6).
//
// One command that answers "why is this machine behaving differently from
// mine", printed to stdout and exiting without ever opening a window.
//
// It exists because the bugs this app has had all share a shape: they are
// invisible on the developer's machine and unreproducible on the user's. A
// tester who can paste one block of text turns "the buyer side isn't working"
// — which could be a permission, an endpoint, a consent gate, a missing native
// addon, or a lag ratchet — into a specific line that says which.
//
// Two rules for everything below:
//
//   Never claim a check ran when it did not. A row that says "not built" is
//   worth more than a row that says "ok" because nothing tested it.
//
//   Never require a live call. Anything needing one is reported as the state
//   it is in, not silently skipped, so the absence is itself visible.

import { app } from 'electron'
import { runChannelSelfTest } from './session-health/channel-test'
import { HEALTH_TUNING } from './session-health/types'
import { transcriptionHealth } from './transcription'
import { readActiveConsent } from './consent-gate'
import { loadAppSettings } from './app-settings'
import { isTrustedFeed } from './updater/policy'

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

/**
 * Windows buyer-side capture path.
 *
 * Reported honestly rather than aspirationally: the per-process loopback addon
 * (docs/windows-capture.md) is designed but not built, so today every platform
 * uses the same whole-system `getDisplayMedia` loopback. Saying "process
 * loopback" here because the code intends to have it one day would make this
 * report actively misleading on the exact machine it exists to debug.
 */
function capturePathReport(): string[] {
  const lines: string[] = []
  if (process.platform === 'win32' || process.platform === 'darwin') {
    lines.push(`  capture path      : system loopback via getDisplayMedia (audio: 'loopback')`)
    lines.push(`  per-process path  : not built — see docs/windows-capture.md`)
    if (process.platform === 'win32') {
      lines.push(`  render endpoints  : not enumerated — the device-loopback fallback that would`)
      lines.push(
        `                      list them (including the eCommunications role) is not built,`
      )
      lines.push(`                      so a headset set as Default Communication Device is still`)
      lines.push(`                      the known cause of silent buyer capture.`)
    }
  } else {
    lines.push(`  capture path      : none — buyer capture is unsupported on ${process.platform}`)
  }
  return lines
}

/** The whole report, as text. Pure enough to snapshot in a test. */
export function buildDiagnoseReport(): string {
  const lines: string[] = []
  const push = (s = ''): number => lines.push(s)

  push('CallRise AI — diagnose')
  push('='.repeat(60))
  push(`  version           : ${safe(() => app.getVersion(), 'unknown')}`)
  push(`  platform          : ${process.platform} ${process.arch}`)
  push(`  electron          : ${process.versions.electron ?? 'unknown'}`)
  push(`  node              : ${process.versions.node}`)
  push(`  packaged          : ${yesNo(safe(() => app.isPackaged, false))}`)
  push()

  push('AUDIO CAPTURE')
  for (const line of capturePathReport()) push(line)
  push()

  push('CHANNEL SELF-TEST')
  // Runs the real interleaver against a known tone per channel. Catches the
  // failure where mic and buyer are swapped — which produces no error at all,
  // just a transcript that attributes the rep's words to the prospect.
  const stereo = runChannelSelfTest(16000, 2)
  push(`  stereo (rep+buyer): ${stereo.pass ? 'PASS' : 'FAIL'} — ${stereo.detail}`)
  push(`  measured rms      : ${stereo.rms.map((r) => r.toFixed(3)).join(', ')}`)
  const mono = runChannelSelfTest(16000, 1)
  push(`  mono (mic only)   : ${mono.pass ? 'PASS' : 'FAIL'} — ${mono.detail}`)
  push()

  push('SESSION HEALTH')
  const health = safe(() => transcriptionHealth(), null)
  if (!health) {
    push('  no call in progress — start one and re-run to capture a live trace')
    push(
      `  thresholds        : warn ${HEALTH_TUNING.warnLagSec}s · shed ${HEALTH_TUNING.shedLagSec}s · reset ${HEALTH_TUNING.resetLagSec}s`
    )
    push(`  queue cap         : ${HEALTH_TUNING.queueCapSec}s of audio`)
    push(`  replay cap        : ${HEALTH_TUNING.replayCapSec}s after a disconnect`)
  } else {
    push(`  submitted         : ${health.submittedSec}s`)
    push(`  acknowledged      : ${health.acknowledgedSec}s`)
    push(
      `  lag (X − Y)       : ${health.lagSec}s  (median ${health.medianLagSec}s, tier ${health.tier})`
    )
    push(`  queued            : ${health.queuedSec}s`)
    push(`  shed this session : ${health.shedSec}s`)
    push(`  socket resets     : ${health.resets}`)
    push(`  drift             : ${health.driftPpm} ppm`)
    if (health.gaps.length === 0) push('  gaps              : none')
    else {
      push('  gaps              :')
      for (const gap of health.gaps) {
        push(
          `    +${Math.round(gap.atMs / 1000)}s  ${Math.round(gap.durationMs / 1000)}s  ${gap.reason}`
        )
      }
    }
  }
  push()

  push('CONSENT GATE')
  const settings = safe(() => loadAppSettings(), null)
  push(
    `  master switch     : ${settings ? yesNo(settings.allowOtherPartyRecording) : 'unreadable'}`
  )
  push(`  always-record     : ${settings ? yesNo(settings.alwaysRecordOtherParty) : 'unreadable'}`)
  const consent = safe(() => readActiveConsent(), null)
  if (!consent) {
    push('  active grant      : none on disk — buyer capture cannot start')
  } else {
    push(`  active grant      : session ${consent.sessionId}, status ${consent.consent.status}`)
    push(`  permits capture   : ${yesNo(consent.consent.recordOtherParty)}`)
    push(`  method            : ${consent.consent.method ?? 'unrecorded'}`)
  }
  push()

  push('UPDATER')
  const feed = safe(() => isTrustedFeed(process.env.UPDATE_FEED_URL), {
    ok: false as const,
    reason: 'unreadable'
  })
  push(`  feed              : ${feed.ok ? 'trusted' : `disabled — ${feed.reason}`}`)
  push()

  push('API KEYS (presence only — never the values)')
  for (const name of ['DEEPGRAM_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
    push(`  ${name.padEnd(18)}: ${process.env[name]?.trim() ? 'set' : 'not set'}`)
  }
  push()

  push('='.repeat(60))
  return lines.join('\n')
}

/** True when the process was started with `--diagnose`. */
export function wantsDiagnose(argv: string[] = process.argv): boolean {
  return argv.includes('--diagnose')
}
