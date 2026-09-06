import { useEffect } from 'react'
import { PhoneCall, KeyRound, Sparkles, MessageSquareWarning, TrendingUp, Search, ArrowRight, FlaskConical } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { Badge } from '@renderer/components/Badge'
import { Button } from '@renderer/components/Button'
import { SpeakerTranscript } from '@renderer/components/SpeakerTranscript'
import { cn } from '@renderer/lib/cn'
import {
  SAMPLE_CALL_DURATION_LABEL,
  SAMPLE_CALL_TITLE,
  SAMPLE_COACHING,
  SAMPLE_CUES,
  SAMPLE_SEGMENTS,
  markSampleCallSeen,
  type SampleCue
} from './sampleCall'

/**
 * M36 Stage 1 — the sample call, read-only. Reached from Home (a card that
 * disappears once seen) and from the live view's "needs a key" state — the
 * two places the Stage 2 walk showed a stranger stalling with nothing to look
 * at. Renders entirely from sampleCall.ts; stores nothing. Every panel says
 * "sample" so it can never be mistaken for the user's own data.
 */
export function SampleCallView({
  onStartCall,
  onAddKey
}: {
  /** "Start my first call" — navigates to the live view. */
  onStartCall: () => void
  /** "Add a key" — navigates to Settings → API keys. */
  onAddKey: () => void
}): React.JSX.Element {
  useEffect(() => markSampleCallSeen(), [])

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6" data-testid="sample-call-view">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3">
        <FlaskConical className="h-4 w-4 shrink-0 text-accent" />
        <p className="text-[13px] text-ink">
          <span className="font-semibold">This is a sample call.</span> The people are invented and nothing here is saved
          to your calls, contacts or memory. It shows what CallRise does with a real one.
        </p>
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{SAMPLE_CALL_TITLE}</h1>
          <p className="mt-0.5 text-[13px] text-muted">
            {SAMPLE_CALL_DURATION_LABEL} · 2 speakers · second call in the deal
          </p>
        </div>
        <Badge tone="neutral">Sample</Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold">Transcript</h2>
          <SpeakerTranscript segments={SAMPLE_SEGMENTS} repSpeaker={0} />
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="mb-1 text-sm font-semibold">What you would have seen live</h2>
            <p className="mb-3 text-[12px] text-muted">
              Cues appear beside the transcript as the call happens. These are the ones this call would have raised, written for this
              transcript — not produced by a model.
            </p>
            <ol className="space-y-2">
              {SAMPLE_CUES.map((cue) => (
                <li key={cue.afterSegment} className="flex items-start gap-2 rounded-lg border border-line-soft bg-canvas px-3 py-2">
                  <CueIcon kind={cue.kind} />
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wide text-faint">
                      after turn {cue.afterSegment + 1} · {cueLabel(cue.kind)}
                    </p>
                    <p className="text-[13px] text-ink">{cue.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          <Card className="p-4">
            <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4 text-accent" /> Coaching, after the call
            </h2>
            <p className="mb-3 text-[12px] text-muted">
              With an AI provider key, this is generated from the transcript. This one is written by hand for the sample.
            </p>
            <p className="text-[13px] leading-relaxed text-ink">{SAMPLE_COACHING.summary}</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-faint">Worked</p>
                <ul className="mt-1 space-y-1 text-[12px] text-ink">
                  {SAMPLE_COACHING.strengths.map((s) => (
                    <li key={s} className="flex gap-1.5">
                      <span className="text-positive">✓</span>
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-faint">Next time</p>
                <ul className="mt-1 space-y-1 text-[12px] text-ink">
                  {SAMPLE_COACHING.improvements.map((s) => (
                    <li key={s} className="flex gap-1.5">
                      <span className="text-warning">→</span>
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="mt-3 text-[12px] text-muted">
              <span className="font-medium text-ink">Next action:</span> {SAMPLE_COACHING.nextAction}
            </p>
            <p className="mt-1 text-[12px] text-muted">
              <span className="font-medium text-ink">Tasks it would create:</span> {SAMPLE_COACHING.tasks.join(' · ')}
            </p>
          </Card>
        </div>
      </div>

      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-[13px] text-muted">
          To get this from your own calls you need a free Deepgram key (transcription) and one AI provider key (coaching). Both live in
          Settings → API keys.
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onAddKey}>
            <KeyRound className="h-4 w-4" /> Add a key
          </Button>
          <Button onClick={onStartCall}>
            <PhoneCall className="h-4 w-4" /> Start my first call <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </Card>
    </div>
  )
}

function cueLabel(kind: SampleCue['kind']): string {
  return kind === 'objection'
    ? 'objection'
    : kind === 'buying-signal'
      ? 'buying signal'
      : kind === 'discovery'
        ? 'discovery'
        : 'next step'
}

function CueIcon({ kind }: { kind: SampleCue['kind'] }): React.JSX.Element {
  const cls = 'mt-0.5 h-4 w-4 shrink-0'
  if (kind === 'objection') return <MessageSquareWarning className={cn(cls, 'text-warning')} />
  if (kind === 'buying-signal') return <TrendingUp className={cn(cls, 'text-positive')} />
  if (kind === 'discovery') return <Search className={cn(cls, 'text-accent')} />
  return <ArrowRight className={cn(cls, 'text-accent')} />
}
