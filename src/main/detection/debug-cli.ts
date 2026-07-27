/**
 * Headless debug command for ambient call detection (M15 Phase 2/3).
 *
 * Runs the real platform adapter + CallDetector with no Electron, no IPC, no
 * UI - just console output - so detection can be tuned/validated against a
 * real call (open Zoom, join a meeting, watch the confidence climb) without
 * touching the app at all.
 *
 * Run with: npm run detect:debug
 */
import { MacAdapter } from './adapters/MacAdapter'
import { NullAdapter } from './adapters/NullAdapter'
import { WindowsAdapter } from './adapters/WindowsAdapter'
import { CallDetector } from './CallDetector'
import type { ICallDetectorAdapter } from './adapters/ICallDetectorAdapter'

function pickAdapter(): ICallDetectorAdapter {
  if (process.platform === 'darwin') return new MacAdapter()
  if (process.platform === 'win32') return new WindowsAdapter()
  console.log(
    `[detect-debug] No adapter for platform "${process.platform}" yet - using NullAdapter (no real signals).`
  )
  return new NullAdapter()
}

function formatState(state: ReturnType<CallDetector['getState']>): string {
  switch (state.name) {
    case 'idle':
      return 'idle'
    case 'candidate':
      return `candidate  (${state.call.displayName}, confidence=${state.call.confidence.toFixed(2)})`
    case 'detected':
      return `detected   (${state.call.displayName}, confidence=${state.call.confidence.toFixed(2)})`
    case 'capturing':
      return `capturing  (${state.call.displayName}, session=${state.sessionId})`
    case 'capturing-with-pending':
      return `capturing-with-pending  (${state.call.displayName} -> pending: ${state.pending.displayName})`
    case 'ending':
      return `ending     (${state.call.displayName})`
  }
}

function main(): void {
  const adapter = pickAdapter()
  const detector = new CallDetector({ adapter, ourPid: process.pid })

  console.log('--- ambient call detection debug ---')
  console.log(`platform: ${process.platform}`)
  console.log(`adapter supported: ${adapter.isSupported()}`)
  const loadError =
    'loadError' in adapter ? (adapter as MacAdapter | WindowsAdapter).loadError : undefined
  if (loadError) {
    console.log(`native addon load error: ${String(loadError)}`)
    const buildScript = process.platform === 'darwin' ? 'native:build:mac' : 'native:build:win'
    console.log(`Build it first with: npm run ${buildScript}`)
  }
  console.log(
    'Listening for signals. Open a conferencing app to see confidence climb. Ctrl+C to quit.\n'
  )

  detector.onEvent((event) => {
    console.log(`[event] ${JSON.stringify(event)}`)
  })

  detector.start()

  const printInterval = setInterval(() => {
    const snapshot = detector.getDebugSnapshot()
    const top = snapshot.candidates.slice(0, 3)
    const candidateLines = top.length
      ? top.map(
          (c) =>
            `    - ${c.displayName} (${c.appId}${c.pid ? `, pid ${c.pid}` : ''}): confidence=${c.confidence.toFixed(2)} signals=[${c.signals.join(', ')}]`
        )
      : ['    (no candidates)']
    console.log(`[${new Date().toISOString()}] state=${formatState(detector.getState())}`)
    console.log(candidateLines.join('\n'))
  }, 1_000)

  const shutdown = (): void => {
    clearInterval(printInterval)
    detector.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
