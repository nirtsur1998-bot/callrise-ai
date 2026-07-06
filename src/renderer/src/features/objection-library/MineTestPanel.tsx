import { useCallback, useState } from 'react'
import { MessageSquareQuote, Send } from 'lucide-react'
import { TYPE_LABEL, type MinedObjectionCandidate } from './types'

interface MineTestPanelProps {
  callId: string
  /** Mirrors the settings toggle — the button only runs when this is true;
   *  the main process enforces the same gate independently. */
  enabled: boolean
}

/**
 * A manual, one-off test: pick this call, see the AI's RAW suggestions, judge
 * the quality — then, if they look good, send them to the review queue.
 * Nothing reaches the real objection library from here directly; that only
 * happens after you approve each one in the queue.
 */
export function MineTestPanel({ callId, enabled }: MineTestPanelProps): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<MinedObjectionCandidate[] | null>(null)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<number | null>(null)

  const run = useCallback(async () => {
    setError(null)
    setLoading(true)
    setCandidates(null)
    setSent(null)
    try {
      const res = await window.api.calls.mineObjectionsTest(callId)
      if (res.ok) setCandidates(res.candidates)
      else setError(res.message ?? 'Could not mine this call for objections.')
    } catch {
      setError('Could not mine this call. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [callId])

  const sendToQueue = useCallback(async () => {
    if (!candidates?.length) return
    setSending(true)
    try {
      const res = await window.api.calls.enqueueObjections(callId, candidates)
      setSent(res.ok ? res.added : 0)
    } catch {
      setSent(0)
    } finally {
      setSending(false)
    }
  }, [callId, candidates])

  return (
    <section className="rounded-2xl border border-line-soft bg-surface p-6">
      <div className="mb-4 flex items-center gap-2">
        <MessageSquareQuote className="h-4 w-4 text-accent" />
        <h3 className="text-sm font-semibold">Objection Library — test mining</h3>
      </div>
      <p className="mb-3 text-sm text-muted">
        A one-off preview: read this call once and show the raw suggestions, so you can judge the
        quality. Nothing becomes a real script until you approve it in the review queue (Settings →
        Objection Library).
      </p>

      {!enabled ? (
        <p className="text-[13px] text-faint">
          Turn on &quot;Learn objection responses from my calls&quot; in Settings → AI &amp;
          coaching → Objection Library to try this.
        </p>
      ) : (
        <div className="flex flex-col items-start gap-3">
          {error && <p className="text-[13px] text-rose-300">{error}</p>}
          <button
            type="button"
            disabled={loading}
            onClick={run}
            className="flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-ink transition hover:bg-elevated disabled:cursor-default disabled:opacity-50"
          >
            <MessageSquareQuote className="h-4 w-4" />
            {loading ? 'Mining…' : 'Mine this call (test)'}
          </button>

          {candidates && candidates.length === 0 && (
            <p className="text-sm text-muted">No objections found in this call.</p>
          )}

          {candidates && candidates.length > 0 && (
            <div className="w-full space-y-3">
              {candidates.map((c, i) => (
                <div key={i} className="rounded-xl border border-line-soft bg-elevated/40 p-4">
                  <p className="text-[11px] font-semibold tracking-wide text-faint uppercase">
                    {TYPE_LABEL[c.type]}
                  </p>
                  <p className="mt-1.5 text-sm">
                    <span className="text-faint">Buyer said: </span>
                    &ldquo;{c.objectionQuote}&rdquo;
                  </p>
                  <p className="mt-1 text-sm">
                    <span className="text-faint">You responded: </span>
                    &ldquo;{c.responseQuote}&rdquo;
                  </p>
                  <p className="mt-2 text-[12px] text-muted">
                    <span
                      className={
                        c.recoveredWell
                          ? 'font-medium text-emerald-400'
                          : 'font-medium text-amber-400'
                      }
                    >
                      {c.recoveredWell
                        ? 'AI thinks this recovered well'
                        : 'AI is not sure this fully recovered'}
                    </span>{' '}
                    — a suggestion, not a fact. {c.judgmentNote}
                  </p>
                </div>
              ))}

              {sent === null ? (
                <button
                  type="button"
                  disabled={sending}
                  onClick={sendToQueue}
                  className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-50"
                >
                  <Send className="h-4 w-4" />
                  {sending ? 'Sending…' : 'Send to review queue'}
                </button>
              ) : sent > 0 ? (
                <p className="text-[13px] text-emerald-400">
                  Sent {sent} suggestion{sent === 1 ? '' : 's'} to the review queue — see it in
                  Settings → Objection Library.
                </p>
              ) : (
                <p className="text-[13px] text-rose-300">
                  Could not send these to the review queue. Please try again.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
