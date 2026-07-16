import { useState, type FormEvent } from 'react'
import { Sparkles, Send, X, Loader2 } from 'lucide-react'
import { IconButton } from '@renderer/components/IconButton'
import type { CallSegment } from '@renderer/features/calls/types'

interface Answer {
  headline: string
  tips: string[]
}

/**
 * Manual mid-call help. The rep types an objection or question; we send it with
 * the running transcript and show a short, dismissible suggestion. Async — it
 * never blocks the transcript or the cue engine.
 */
export function AskCoach({
  segments,
  interimText
}: {
  segments: CallSegment[]
  interimText: string
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const q = input.trim()
    if (!q || loading) return
    setLoading(true)
    setError(null)
    setAnswer(null)
    const transcript = [...segments.map((s) => s.text), interimText].filter(Boolean).join('\n')
    try {
      const res = await window.api.transcription.askCoach(transcript, q)
      if (res.ok) {
        setAnswer({ headline: res.headline, tips: res.tips })
        setInput('')
      } else {
        setError(res.message ?? 'Could not get help right now.')
      }
    } catch {
      setError('Could not reach the coach. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const dismiss = (): void => {
    setAnswer(null)
    setError(null)
  }

  return (
    <div className="shrink-0 rounded-2xl border border-line-soft bg-surface px-4 py-3">
      {(loading || answer || error) && (
        <div className="mb-3 rounded-xl border border-line-soft bg-canvas p-3">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin text-accent" /> Thinking…
            </div>
          ) : error ? (
            <div className="flex items-start justify-between gap-3">
              <p className="text-[13px] text-danger">{error}</p>
              <DismissButton onClick={dismiss} />
            </div>
          ) : answer ? (
            <div>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2 text-accent">
                  <Sparkles className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-wide">Coach</span>
                </div>
                <DismissButton onClick={dismiss} />
              </div>
              <p className="mt-1.5 text-sm font-medium text-ink">{answer.headline}</p>
              {answer.tips.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {answer.tips.map((t, i) => (
                    <li key={i} className="flex gap-2 text-[13px] text-muted">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      )}

      <form onSubmit={submit} className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 shrink-0 text-faint" />
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the coach… e.g. “they said it’s too expensive”"
          className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
        />
        <button
          type="submit"
          disabled={!input.trim() || loading}
          className="no-drag flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:brightness-110 disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" /> Ask
        </button>
      </form>
    </div>
  )
}

function DismissButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return <IconButton icon={X} onClick={onClick} label="Dismiss" className="h-6 w-6" />
}
