import { useEffect, useState, type ReactNode } from 'react'
import { Loader2, Mic, Settings as SettingsIcon } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { isMac } from '@renderer/lib/platform'
import { Button } from '@renderer/components/Button'
import type { LiveStatus } from '../types'

// What the OS calls its settings app ("System Settings" is macOS-speak).
const SETTINGS_NAME = isMac ? 'System Settings' : 'Settings'
const MIC_SETTINGS_PATH = isMac
  ? 'System Settings → Privacy & Security → Microphone → enable the app, then return here.'
  : 'Settings → Privacy & security → Microphone → allow apps to access your microphone, then return here.'

/** The big "press to start" hero shown before the first session. */
export function IdleHero({
  onStart,
  banner
}: {
  onStart: () => void
  /** M19 Task 3B — "show the prep brief again at call start": an upcoming/
   *  current-meeting banner rendered above the hero, not a separate layout. */
  banner?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      {banner && <div className="mb-6 w-full max-w-sm">{banner}</div>}
      <div className="relative">
        <span
          className="pulse-ring absolute inset-0 rounded-full bg-accent/30"
          aria-hidden="true"
        />
        <button
          type="button"
          onClick={onStart}
          aria-label="Start live transcription"
          className="press no-drag relative grid h-24 w-24 place-items-center rounded-full bg-accent-fill text-on-accent shadow-lg shadow-accent/20 transition hover:brightness-110"
        >
          <Mic className="h-9 w-9" strokeWidth={2} />
        </button>
      </div>
      <h2 className="mt-7 text-xl font-semibold tracking-tight">Start live transcription</h2>
      <p className="mt-2 max-w-sm text-sm text-muted">
        Click the mic and start speaking. Your words appear in real time, word by word.
      </p>
      <p className="mt-3 max-w-sm text-xs text-faint">
        Records your microphone only. To record the other party, you&rsquo;ll confirm their consent
        once the call starts.
      </p>
    </div>
  )
}

interface CenteredStateProps {
  icon: ReactNode
  title: string
  subtitle: string
  action?: { label: string; onClick: () => void }
  children?: ReactNode
}

/** Generic centered status card (errors, no-device, requesting, …). */
/**
 * M26 4.3 — shown while main has not yet said whether a call is in progress.
 *
 * Renders NOTHING for the first moment, because attach normally resolves in
 * single-digit milliseconds and a spinner that appears and vanishes that fast
 * is worse than no spinner at all. Note what is being delayed: the appearance
 * of a SPINNER. A delay that resolved to the idle screen would be exactly the
 * forbidden thing — deciding there is no call because an answer was slow.
 */
export function AttachingState(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 200)
    return () => clearTimeout(t)
  }, [])
  if (!visible) return null
  return (
    <CenteredState
      icon={<Loader2 className="h-6 w-6 animate-spin text-muted" />}
      title="Checking for a call in progress…"
      subtitle="One moment."
    />
  )
}

export function CenteredState({
  icon,
  title,
  subtitle,
  action,
  children
}: CenteredStateProps): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-line-soft bg-surface">
        {icon}
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1.5 max-w-sm text-sm text-muted">{subtitle}</p>
      {children}
      {action && (
        <Button className="no-drag mt-5" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}

/** Calm, helpful message when microphone permission is denied. */
export function DeniedState({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <CenteredState
      icon={<Mic className="h-6 w-6 text-faint" />}
      title="Microphone access is off"
      subtitle={`CallRise AI needs permission to use your microphone. Turn it on in ${SETTINGS_NAME}, then try again.`}
    >
      <div className="mt-5 flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => void window.api.transcription.openMicSettings()}
          className="no-drag flex items-center gap-2 rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink transition hover:bg-elevated"
        >
          <SettingsIcon className="h-4 w-4" /> Open {SETTINGS_NAME}
        </button>
        <Button className="no-drag" onClick={onRetry}>
          Try again
        </Button>
      </div>
      <p className="mt-4 max-w-sm text-xs text-faint">{MIC_SETTINGS_PATH}</p>
    </CenteredState>
  )
}

/** Setup guidance when the Deepgram API key is missing. */
export function NoKeyState({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <CenteredState
      icon={<Mic className="h-6 w-6 text-faint" />}
      title="Add your Deepgram API key"
      subtitle="Live transcription needs a Deepgram key — it's free, no credit card, takes a minute."
    >
      <div className="mt-5 w-full max-w-md rounded-xl border border-line-soft bg-surface p-4 text-left">
        <ol className="list-decimal space-y-1.5 pl-4 text-[13px] text-muted">
          <li>
            Create a free key at <span className="text-accent">console.deepgram.com</span>
          </li>
          <li>
            Paste it into <span className="text-ink">Settings → API keys</span>
          </li>
          <li>Restart the app, then click Try again</li>
        </ol>
      </div>
      <Button className="no-drag mt-5" onClick={onRetry}>
        Try again
      </Button>
    </CenteredState>
  )
}

/** Small colored "Listening / Paused / …" pill. */
export function StatusBadge({ status }: { status: LiveStatus }): React.JSX.Element {
  const map: Partial<Record<LiveStatus, { label: string; dot: string; text: string }>> = {
    listening: { label: 'Listening', dot: 'bg-positive', text: 'text-positive' },
    paused: { label: 'Paused', dot: 'bg-warning', text: 'text-warning' },
    reconnecting: {
      label: 'Reconnecting',
      dot: 'bg-warning animate-pulse',
      text: 'text-warning'
    },
    connecting: { label: 'Connecting', dot: 'bg-accent animate-pulse', text: 'text-muted' },
    // M26 4.3 — without this the ?? fallback below renders "Stopped" while we
    // are still asking main whether a call is running: the same lie the
    // attaching state exists to prevent, in miniature.
    attaching: { label: 'Checking', dot: 'bg-accent animate-pulse', text: 'text-muted' }
  }
  const s = map[status] ?? { label: 'Stopped', dot: 'bg-faint', text: 'text-faint' }
  return (
    <div className="flex items-center gap-2">
      <span className={cn('h-2 w-2 rounded-full', s.dot)} />
      <span className={cn('text-sm font-medium', s.text)}>{s.label}</span>
    </div>
  )
}

/** Inline banner shown above the transcript so it stays visible during issues. */
export function InlineBanner({
  tone,
  children
}: {
  tone: 'warning' | 'danger' | 'positive'
  children: ReactNode
}): React.JSX.Element {
  const cls =
    tone === 'danger'
      ? 'border-danger/30 bg-danger-soft text-danger'
      : tone === 'positive'
        ? 'border-positive/30 bg-positive-soft text-positive'
        : 'border-warning/30 bg-warning-soft text-warning'
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-sm',
        cls
      )}
    >
      {children}
    </div>
  )
}
