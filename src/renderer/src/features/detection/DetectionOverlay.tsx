import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Mic, Pause, Square, ExternalLink, PhoneIncoming, ArrowLeftRight, X } from 'lucide-react'

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
 *  (main/detection-overlay.ts), so this IS the visible shape.
 *
 *  The outer `p-4` (matching main's CARD_INSET) is deliberate transparent
 *  margin, not decorative spacing — the card's own drop shadow needs room
 *  outside its own border to render at all; without it, the shadow gets
 *  clipped flush at the window's edge and is invisible. */
function OverlayShell({ children }: { children: ReactNode }): React.JSX.Element {
  // This window (unlike every other .glass-hud user) is a fully transparent
  // BrowserWindow with nothing painted behind it, which makes CSS
  // backdrop-filter render as flat opaque black on win32 — see index.css's
  // .platform-win32 .glass-hud override for the actual fix and why.
  const platformClass = window.api.platform === 'win32' ? 'platform-win32' : ''
  // BUG-155 — this window is click-through (main sets setIgnoreMouseEvents
  // with forward:true), so scrolls over the transparent inset around the
  // card reach the app underneath instead of dying in a window the user
  // cannot even see. Input is claimed back only while the pointer is
  // genuinely over the card, and released the moment it leaves.
  //
  // Driven off forwarded mousemove rather than onMouseEnter/onMouseLeave:
  // while ignoring is ON the element receives no enter/leave events at all,
  // so those handlers could never fire to turn it back off -- the card
  // would be permanently dead. mousemove keeps arriving because of
  // forward:true, which is the whole reason that flag is set.
  const cardRef = useRef<HTMLDivElement | null>(null)
  const interactiveRef = useRef(false)
  useEffect(() => {
    const setInteractive = (next: boolean): void => {
      if (interactiveRef.current === next) return // don't spam IPC on every pixel
      interactiveRef.current = next
      void window.api.detection.setOverlayInteractive(next)
    }
    const onMove = (e: MouseEvent): void => {
      const r = cardRef.current?.getBoundingClientRect()
      if (!r) return
      setInteractive(
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      )
    }
    // Leaving the window entirely must release too, or the pointer can exit
    // across the card's edge without a final mousemove inside the bounds.
    const onLeave = (): void => setInteractive(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseleave', onLeave)
      // Never leave the window holding the pointer after unmount.
      void window.api.detection.setOverlayInteractive(false)
    }
  }, [])

  return (
    <div className={`h-full w-full p-4 ${platformClass}`}>
      {/* Same glass material as the call-detected banner (.glass-hud), because
          a rep can see both within the same second and two different-looking
          floating panels read as two different apps. The radius is larger here
          — a taller card wants a generous squircle where a single-row bar
          wants a capsule. */}
      <div
        ref={cardRef}
        data-overlay-card=""
        style={DRAG}
        className="glass-hud animate-pop relative flex h-full flex-col justify-center gap-2.5 overflow-hidden rounded-[32px] p-4"
      >
        <span className="glass-sheen" />
        {children}
      </div>
    </div>
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

// Mirrors main/detection/types.ts's DETECTION_TUNING (this file can't import
// from src/main - see the DetectorState type note above) - keep in sync if
// those ever change.
const DETECTION_TOAST_TIMEOUT_MS = 20_000
const SWITCH_PROMPT_TIMEOUT_MS = 30_000

// A small, deliberately calm palette (not an arbitrary hue-rotate) so a
// monogram color always reads as "part of this app's design system" even
// for an app we've never seen before.
const MONOGRAM_COLORS = [
  '#6e7bf2', // accent indigo
  '#9b6cf2', // violet
  '#4fb0c9', // teal
  '#e0a63d', // amber
  '#e2687a', // rose
  '#48c78e', // emerald
  '#5aa9e6', // sky
  '#d16bd6' // fuchsia
]

function hashColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  return MONOGRAM_COLORS[Math.abs(hash) % MONOGRAM_COLORS.length]
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/**
 * The call source's identity — this is deliberately the HERO element (see
 * M17 §3.3): a colour-hashed monogram so an app we've never heard of still
 * looks as finished as a recognized one, never a generic "unknown app"
 * placeholder. A real per-app logo (bundled SVG) or an OS-extracted icon
 * would slot in ahead of this as stronger tiers of the same resolution
 * order — neither is wired up yet (icon extraction needs native code; see
 * docs/detection.md's "Not yet done"), so the monogram is the only tier
 * implemented today, applied uniformly to every source, known or not.
 */
function SourceMonogram({
  appId,
  displayName
}: {
  appId: string
  displayName: string
}): React.JSX.Element {
  const color = hashColor(appId)
  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[13px] text-[13px] font-bold text-white shadow-[0_2px_8px_-2px_rgba(0,0,0,0.5)]"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    >
      {initials(displayName)}
    </span>
  )
}

/** Uppercase source-name pill — "the answer to which source is being used." */
function SourceNameChip({ displayName }: { displayName: string }): React.JSX.Element {
  return (
    <span className="inline-flex w-fit items-center rounded-full bg-white/[0.08] px-2 py-0.5 text-[10px] font-bold tracking-wide text-ink uppercase">
      {displayName}
    </span>
  )
}

/** Thin linear countdown reusing the app's existing .cue-countdown utility
 *  (already used for live-cue auto-dismiss) so an auto-dismissing prompt
 *  visibly shows time running out instead of surprising the user. */
function DismissCountdown({ durationMs }: { durationMs: number }): React.JSX.Element {
  return (
    <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/[0.06]">
      <div
        className="cue-countdown h-full rounded-full bg-white/30"
        style={{ animationDuration: `${durationMs}ms` }}
      />
    </div>
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
          <SourceMonogram appId={pending.appId} displayName={pending.displayName} />
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <SourceNameChip displayName={pending.displayName} />
              <ArrowLeftRight className="h-3 w-3 text-faint" />
              <SourceNameChip displayName={current.displayName} />
            </div>
            <p className="truncate text-[13px] font-semibold text-ink">
              New call detected in {pending.displayName}
            </p>
            <p className="mt-0.5 truncate text-[12px] text-muted">
              Currently capturing {current.displayName}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <PrimaryPill onClick={() => void window.api.detection.respondToSwitch('switch')}>
            Switch capture
          </PrimaryPill>
          <SecondaryPill onClick={() => void window.api.detection.respondToSwitch('keep')}>
            Keep current
          </SecondaryPill>
        </div>
        <div className="flex items-center justify-between gap-2">
          <button
            style={NO_DRAG}
            className="text-[11px] text-faint underline-offset-2 hover:underline"
            onClick={() => {
              void declineWithNever(pending.appId)
              void window.api.detection.respondToSwitch('keep')
            }}
          >
            Never ask for {pending.displayName}
          </button>
        </div>
        <DismissCountdown durationMs={SWITCH_PROMPT_TIMEOUT_MS} />
      </OverlayShell>
    )
  }

  if (toastCall) {
    return (
      <OverlayShell>
        <div className="flex items-start gap-2.5">
          <SourceMonogram appId={toastCall.appId} displayName={toastCall.displayName} />
          <div className="min-w-0 flex-1">
            <SourceNameChip displayName={toastCall.displayName} />
            <p className="mt-1 truncate text-[13px] font-semibold text-ink">Call detected</p>
          </div>
          <PhoneIncoming className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" />
        </div>
        <div className="flex gap-2">
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
        <DismissCountdown durationMs={DETECTION_TOAST_TIMEOUT_MS} />
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
          <SourceMonogram appId={call.appId} displayName={call.displayName} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <LiveDot />
              <SourceNameChip displayName={call.displayName} />
            </div>
            <p className="mt-1 truncate text-[13px] font-semibold text-ink">{label}</p>
          </div>
          <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-0.5 text-[12px] font-semibold tabular-nums text-ink">
            {elapsed}
          </span>
        </div>
        <div style={NO_DRAG} className="flex items-center gap-2">
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
        <button
          style={NO_DRAG}
          className="press flex items-center gap-1 self-start text-[11px] text-faint hover:text-muted"
          onClick={() => {
            void declineWithNever(call.appId)
            void window.api.detection.requestStopCapture()
          }}
        >
          <X className="h-3 w-3" /> Not a call — stop detecting {call.displayName}
        </button>
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
