import { useCallback, useState } from 'react'
import { MessageSquareQuote, Send, Check, AlertTriangle } from 'lucide-react'
import { Badge } from '@renderer/components/Badge'
import { Button } from '@renderer/components/Button'
import { EmptyState } from '@renderer/components/EmptyState'
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
        // M31 Stage 3. What was here is the dead end this stage is about: a
        // sentence telling you where to go, with nothing to click — and by
        // now naming a path that no longer exists ("Settings -> AI & coaching
        // -> Objection Library"; that group is called Coaching now). Copy
        // that hardcodes a route rots the first time the route moves, and
        // nothing fails when it does.
        <EmptyState
          compact
          icon={MessageSquareQuote}
          title="Objection mining is switched off"
          reason={{
            kind: 'off',
            settingsPage: 'objection-library',
            what: 'Reads your call transcripts for the moments a buyer pushed back and what you said next, then turns the answers that worked into reusable scripts you can edit and keep.',
            cost: 'Makes an AI call per mined call. Off by default, and you approve every suggestion before it becomes a real script.',
            actionLabel: 'Turn on objection mining'
          }}
        />
      ) : (
        <div className="flex flex-col items-start gap-3">
          {error && <p className="text-[13px] text-danger">{error}</p>}
          <Button variant="secondary" icon={MessageSquareQuote} disabled={loading} onClick={run}>
            {loading ? 'Mining…' : 'Mine this call (test)'}
          </Button>

          {candidates && candidates.length === 0 && (
            <EmptyState
              compact
              icon={MessageSquareQuote}
              title="No objections found"
              description="This call didn't have any clear buyer pushback for the AI to pull out."
            />
          )}

          {candidates && candidates.length > 0 && (
            <div className="w-full space-y-3">
              {candidates.map((c, i) => (
                <div key={i} className="rounded-xl border border-line-soft bg-elevated/40 p-4">
                  <Badge tone="neutral">{TYPE_LABEL[c.type]}</Badge>
                  <p className="mt-1.5 text-sm">
                    <span className="text-faint">Buyer said: </span>
                    &ldquo;{c.objectionQuote}&rdquo;
                  </p>
                  <p className="mt-1 text-sm">
                    <span className="text-faint">You responded: </span>
                    &ldquo;{c.responseQuote}&rdquo;
                  </p>
                  <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                    {c.recoveredWell ? (
                      <Badge tone="positive" icon={Check}>
                        Recovered well
                      </Badge>
                    ) : (
                      <Badge tone="warning" icon={AlertTriangle}>
                        Not sure it recovered
                      </Badge>
                    )}
                    <span>— a suggestion, not a fact. {c.judgmentNote}</span>
                  </p>
                </div>
              ))}

              {sent === null ? (
                <Button icon={Send} disabled={sending} onClick={sendToQueue}>
                  {sending ? 'Sending…' : 'Send to review queue'}
                </Button>
              ) : sent > 0 ? (
                <p className="text-[13px] text-positive">
                  Sent {sent} suggestion{sent === 1 ? '' : 's'} to the review queue — see it in
                  Settings → Objection Library.
                </p>
              ) : (
                <p className="text-[13px] text-danger">
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
