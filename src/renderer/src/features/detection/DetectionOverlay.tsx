import { useEffect, useState, type ReactNode } from 'react'
import { Mic, Pause, Square, ExternalLink, PhoneIncoming, ArrowLeftRight } from 'lucide-react'

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

/** Shared glass-capsule shell for every overlay state — a Dynamic-Island /
 *  Live-Activity-style floating HUD: blurred translucent surface, a subtle
 *  top sheen, and a soft indigo-tinted glow instead of the app's normal flat
 *  card treatment. The window behind this is already fully transparent
 *  (main/detection-overlay.ts), so this IS the visible shape. */
function OverlayShell({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div
      style={DRAG}
      className="animate-pop relative flex h-full flex-col justify-center gap-2.5 overflow-hidden rounded-[26px] border border-white/10 bg-surface/75 p-4 shadow-[0_0_0_1px_rgba(110,123,242,0.12),0_16px_40px_-12px_rgba(0,0,0,0.55)] backdrop-blur-2xl"
    >
      <div className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />
      {children}
    </div>
  )
}

/** Small circular glyph badge, matching the "live activity" icon-in-a-ring look. */
function IconBadge({ icon: Icon }: { icon: typeof Mic }): React.JSX.Element {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft ring-1 ring-inset ring-accent/25">
      <Icon className="h-3.5 w-3.5 text-accent" strokeWidth={2.25} />
    </span>
  )
}

function PrimaryPill({
  children,
  onClick
}: {
  children: ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      style={NO_DRAG}
      onClick={onClick}
      className="press flex-1 rounded-full bg-brand px-3 py-1.5 text-[12px] font-semibold text-white shadow-[0_4px_14px_-4px_rgba(110,123,242,0.6)]"
    >
      {children}
    </button>
  )
}

function SecondaryPill({
  children,
  onClick
}: {
  children: ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      style={NO_DRAG}
      onClick={onClick}
      className="press flex-1 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-white/[0.08]"
    >
      {children}
    </button>
  )
}

/** The breathing "live" dot — a solid center dot with a softly expanding
 *  halo behind it (the .pulse-ring utility), the same "unmistakably live"
 *  language as the honest recording indicator elsewhere in the app. */
function LiveDot(): React.JSX.Element {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
      <span className="pulse-ring absolute inset-0 rounded-full bg-danger" />
      <span className="relative h-2 w-2 rounded-full bg-danger" />
    </span>
  )
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
      <OverlayShell>
        <div className="flex items-start gap-2.5">
          <IconBadge icon={ArrowLeftRight} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-ink">
              New call detected in {pending.displayName}
            </p>
            <p className="mt-0.5 truncate text-[12px] text-muted">
              Currently capturing {current.displayName}
            </p>
          </div>
        </div>
        <div className="mt-1 flex gap-2">
          <PrimaryPill onClick={() => void window.api.detection.respondToSwitch('switch')}>
            Switch capture
          </PrimaryPill>
          <SecondaryPill onClick={() => void window.api.detection.respondToSwitch('keep')}>
            Keep current
          </SecondaryPill>
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
      </OverlayShell>
    )
  }

  if (toastCall) {
    return (
      <OverlayShell>
        <div className="flex items-start gap-2.5">
          <IconBadge icon={PhoneIncoming} />
          <p className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
            Call detected in {toastCall.displayName}
          </p>
        </div>
        <div className="mt-1 flex gap-2">
          <PrimaryPill onClick={() => void window.api.detection.respondToDetection('accept')}>
            Start capturing
          </PrimaryPill>
          <SecondaryPill onClick={() => void window.api.detection.respondToDetection('decline')}>
            Not now
          </SecondaryPill>
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
      </OverlayShell>
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
      <OverlayShell>
        <div className="flex items-center gap-2.5">
          <LiveDot />
          <p className="flex-1 truncate text-[13px] font-semibold text-ink">{label}</p>
          <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-0.5 text-[12px] font-semibold tabular-nums text-ink">
            {elapsed}
          </span>
        </div>
        <p className="truncate pl-5 text-[12px] text-muted">{call.displayName}</p>
        <div style={NO_DRAG} className="mt-0.5 flex items-center gap-2">
          <button
            className="press flex flex-1 items-center justify-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-white/[0.08]"
            onClick={() => void window.api.detection.requestTogglePause()}
          >
            <Pause className="h-3.5 w-3.5" /> Pause
          </button>
          <button
            className="press flex flex-1 items-center justify-center gap-1.5 rounded-full bg-danger-soft px-3 py-1.5 text-[12px] font-semibold text-danger ring-1 ring-inset ring-danger/25"
            onClick={() => void window.api.detection.requestStopCapture()}
          >
            <Square className="h-3.5 w-3.5" /> Stop
          </button>
          <button
            className="press flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-ink hover:bg-white/[0.08]"
            onClick={() => void window.api.detection.openMainWindow()}
            aria-label="Open CallRise AI"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
      </OverlayShell>
    )
  }

  return (
    <OverlayShell>
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-faint">
        <Mic className="h-3.5 w-3.5" /> CallRise AI
      </div>
    </OverlayShell>
  )
}
