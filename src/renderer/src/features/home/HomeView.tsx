import { PhoneCall, Sparkles } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { AudioSourcesCard } from '@renderer/features/audio/AudioSourcesCard'

const STATS = [
  { label: 'Calls today', value: '—' },
  { label: 'Talk time', value: '—' },
  { label: 'Tasks due', value: '—' }
] as const

export function HomeView(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl">
      {/* Greeting */}
      <header className="mb-7">
        <h2 className="text-2xl font-semibold tracking-tight">Welcome to Sales OS</h2>
        <p className="mt-1.5 text-sm text-muted">
          Your AI assistant for sales calls. This is an early shell — features will land here step
          by step.
        </p>
      </header>

      {/* Audio sources — pick your mic, see where the call plays */}
      <AudioSourcesCard />

      {/* Primary action (placeholder, disabled) */}
      <Card className="mb-5 flex items-center justify-between gap-4 bg-elevated">
        <div className="flex items-center gap-4">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-accent-soft">
            <PhoneCall className="h-5 w-5 text-accent" strokeWidth={2} />
          </div>
          <div>
            <p className="font-medium">Start a live call</p>
            <p className="text-[13px] text-muted">
              Live transcription &amp; coaching — coming soon
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled
          className="cursor-not-allowed rounded-lg border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-faint"
        >
          Soon
        </button>
      </Card>

      {/* Stat row */}
      <div className="mb-5 grid grid-cols-3 gap-4">
        {STATS.map((stat) => (
          <Card key={stat.label}>
            <p className="text-[13px] text-muted">{stat.label}</p>
            <p className="mt-2 text-2xl font-semibold tracking-tight">{stat.value}</p>
          </Card>
        ))}
      </div>

      {/* Recent calls — empty state */}
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium">Recent calls</h3>
          <Sparkles className="h-4 w-4 text-faint" />
        </div>
        <div className="rounded-xl border border-dashed border-line py-10 text-center">
          <p className="text-sm text-muted">No calls yet</p>
          <p className="mt-1 text-[13px] text-faint">Your call history will show up here.</p>
        </div>
      </Card>
    </div>
  )
}
