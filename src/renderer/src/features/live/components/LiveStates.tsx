import type { ReactNode } from 'react'
import { Mic, Settings as SettingsIcon } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import type { LiveStatus } from '../types'

/** The big "press to start" hero shown before the first session. */
export function IdleHero({ onStart }: { onStart: () => void }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <button
        type="button"
        onClick={onStart}
        className="no-drag grid h-24 w-24 place-items-center rounded-full bg-accent text-white shadow-lg shadow-accent/20 transition hover:brightness-110 active:scale-95"
      >
        <Mic className="h-9 w-9" strokeWidth={2} />
      </button>
      <h2 className="mt-7 text-xl font-semibold tracking-tight">Start live transcription</h2>
      <p className="mt-2 max-w-sm text-sm text-muted">
        Click the mic and start speaking. Your words appear in real time, word by word.
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
        <button
          type="button"
          onClick={action.onClick}
          className="no-drag mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:brightness-110"
        >
          {action.label}
        </button>
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
      subtitle="Sales OS needs permission to use your microphone. Turn it on in System Settings, then try again."
    >
      <div className="mt-5 flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => void window.api.transcription.openMicSettings()}
          className="no-drag flex items-center gap-2 rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink transition hover:bg-elevated"
        >
          <SettingsIcon className="h-4 w-4" /> Open System Settings
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="no-drag rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110"
        >
          Try again
        </button>
      </div>
      <p className="mt-4 max-w-sm text-xs text-faint">
        System Settings → Privacy &amp; Security → Microphone → enable the app, then return here.
      </p>
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
            Open the <code className="rounded bg-canvas px-1 py-0.5 text-ink">.env</code> file in
            your project
          </li>
          <li>
            Paste it:{' '}
            <code className="rounded bg-canvas px-1 py-0.5 text-ink">DEEPGRAM_API_KEY=your_key</code>
          </li>
          <li>Restart the app, then click Try again</li>
        </ol>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="no-drag mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:brightness-110"
      >
        Try again
      </button>
    </CenteredState>
  )
}

/** Small colored "Listening / Paused / …" pill. */
export function StatusBadge({ status }: { status: LiveStatus }): React.JSX.Element {
  const map: Partial<Record<LiveStatus, { label: string; dot: string; text: string }>> = {
    listening: { label: 'Listening', dot: 'bg-emerald-400', text: 'text-emerald-300' },
    paused: { label: 'Paused', dot: 'bg-amber-400', text: 'text-amber-300' },
    reconnecting: { label: 'Reconnecting', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300' },
    connecting: { label: 'Connecting', dot: 'bg-accent animate-pulse', text: 'text-muted' }
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
  tone: 'amber' | 'rose' | 'emerald'
  children: ReactNode
}): React.JSX.Element {
  const cls =
    tone === 'rose'
      ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
      : tone === 'emerald'
        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
        : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
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
