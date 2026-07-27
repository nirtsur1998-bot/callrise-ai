import { useEffect, useState } from 'react'
import { Mic, Pause, Square, ExternalLink } from 'lucide-react'

// Derived from the preload-declared API rather than imported from
// main/detection/types.ts directly - this file is under tsconfig.web.json's
// scope, which doesn't include src/main. Same trick useAppSettings.ts uses
// for AppSettings.
type DetectorState = NonNullable<Awaited<ReturnType<typeof window.api.detection.getState>>>
type DetectedCall = NonNullable<
  Parameters<Parameters<typeof window.api.detection.onCallDetected>[0]>[0]
>

const DRAG: React.CSSProperties = { WebkitAppRegion: 'drag' } as React.CSSProperties
const NO_DRAG: React.CSSProperties = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Content for the ONE always-on-top overlay window (see main/detection-overlay.ts).
 * Switches between three views based purely on IPC state - the window itself
 * is only ever shown by main when one of these is actually relevant, so
 * "hidden" here is mostly a defensive fallback.
 */
export function DetectionOverlay(): React.JSX.Element | null {
  const [state, setState] = useState<DetectorState>({ name: 'idle' })
  const [toastCall, setToastCall] = useState<DetectedCall | null>(null)
  const [switchOffer, setSwitchOffer] = useState<{
    current: DetectedCall
    pending: DetectedCall
  } | null>(null)
  const [captureMode, setCaptureMode] = useState<'full' | 'mic-only' | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    void window.api.detection.getState().then((s) => s && setState(s))
    const offState = window.api.detection.onStateChanged(({ state: s }) => setState(s))
    const offCallDetected = window.api.detection.onCallDetected((call) => setToastCall(call))
    const offSwitchOffered = window.api.detection.onSwitchOffered((payload) =>
      setSwitchOffer(payload)
    )
    const offEvent = window.api.detection.onEvent((event) => {
      if (event.type === 'capture-started') {
        setToastCall(null)
        setCaptureMode(event.mode)
      }
      if (event.type === 'call-lost') setToastCall(null)
      if (event.type === 'switch-resolved' || event.type === 'capture-ended') setSwitchOffer(null)
      if (event.type === 'capture-ended') setCaptureMode(null)
    })
    return () => {
      offState()
      offCallDetected()
      offSwitchOffered()
      offEvent()
    }
  }, [])

  const showingCapture =
    state.name === 'capturing' || state.name === 'capturing-with-pending' || state.name === 'ending'

  useEffect(() => {
    if (!showingCapture) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [showingCapture])

  const declineWithNever = async (appId: string): Promise<void> => {
    const settings = await window.api.settings.get()
    const nextOverrides = {
      ...settings.detection.capturePolicy.appOverrides,
      [appId]: 'never' as const
    }
    await window.api.settings.update({
      detection: { capturePolicy: { appOverrides: nextOverrides } }
    })
  }

  if (switchOffer) {
    const { current, pending } = switchOffer
    return (
      <div
        style={DRAG}
        className="flex h-full flex-col justify-center gap-2.5 rounded-2xl border border-line bg-surface p-4 shadow-xl"
      >
        <p className="text-[13px] font-medium text-ink">
          New call detected in {pending.displayName}
        </p>
        <p className="text-[12px] text-muted">
          You&rsquo;re currently capturing {current.displayName}.
        </p>
        <div style={NO_DRAG} className="mt-1 flex gap-2">
          <button
            className="press flex-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white"
            onClick={() => void window.api.detection.respondToSwitch('switch')}
          >
            Switch capture
          </button>
          <button
            className="press flex-1 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink"
            onClick={() => void window.api.detection.respondToSwitch('keep')}
          >
            Keep current
          </button>
        </div>
        <button
          style={NO_DRAG}
          className="self-start text-[11px] text-faint underline-offset-2 hover:underline"
          onClick={() => {
            void declineWithNever(pending.appId)
            void window.api.detection.respondToSwitch('keep')
          }}
        >
          Never ask for {pending.displayName}
        </button>
      </div>
    )
  }

  if (toastCall) {
    return (
      <div
        style={DRAG}
        className="flex h-full flex-col justify-center gap-2.5 rounded-2xl border border-line bg-surface p-4 shadow-xl"
      >
        <p className="text-[13px] font-medium text-ink">Call detected in {toastCall.displayName}</p>
        <div style={NO_DRAG} className="mt-1 flex gap-2">
          <button
            className="press flex-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white"
            onClick={() => void window.api.detection.respondToDetection('accept')}
          >
            Start capturing
          </button>
          <button
            className="press flex-1 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink"
            onClick={() => void window.api.detection.respondToDetection('decline')}
          >
            Not now
          </button>
        </div>
        <button
          style={NO_DRAG}
          className="self-start text-[11px] text-faint underline-offset-2 hover:underline"
          onClick={() => {
            void declineWithNever(toastCall.appId)
            void window.api.detection.respondToDetection('decline')
          }}
        >
          Never for {toastCall.displayName}
        </button>
      </div>
    )
  }

  if (
    showingCapture &&
    (state.name === 'capturing' ||
      state.name === 'capturing-with-pending' ||
      state.name === 'ending')
  ) {
    const call = state.call
    const elapsed = formatElapsed(now - call.startedAt)
    const label =
      state.name === 'ending'
        ? 'Wrapping up…'
        : captureMode === 'mic-only'
          ? 'Capturing your side only — waiting for consent'
          : 'Capturing this call live'
    return (
      <div
        style={DRAG}
        className="flex h-full flex-col justify-center gap-2.5 rounded-2xl border border-line bg-surface p-4 shadow-xl"
      >
        <div className="flex items-center gap-2">
          <span className="flex h-2 w-2 shrink-0 rounded-full bg-danger" />
          <p className="flex-1 text-[13px] font-medium text-ink">{label}</p>
          <span className="tabular-nums text-[12px] text-muted">{elapsed}</span>
        </div>
        <p className="text-[12px] text-muted">{call.displayName}</p>
        <div style={NO_DRAG} className="mt-1 flex gap-2">
          <button
            className="press flex items-center justify-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink"
            onClick={() => void window.api.detection.requestTogglePause()}
          >
            <Pause className="h-3.5 w-3.5" /> Pause
          </button>
          <button
            className="press flex items-center justify-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-danger"
            onClick={() => void window.api.detection.requestStopCapture()}
          >
            <Square className="h-3.5 w-3.5" /> Stop
          </button>
          <button
            className="press flex items-center justify-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink"
            onClick={() => void window.api.detection.openMainWindow()}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      style={DRAG}
      className="flex h-full items-center justify-center gap-2 rounded-2xl border border-line bg-surface p-4 text-[12px] text-faint shadow-xl"
    >
      <Mic className="h-3.5 w-3.5" /> CallRise AI
    </div>
  )
}
