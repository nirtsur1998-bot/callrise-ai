import { useEffect, useState } from 'react'
import { Brain, SkipForward, X } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import type { OnboardingStatusResult } from '../../../../preload/index.d'

interface OnboardingInterviewModalProps {
  onClose: () => void
  /** Called after the interview reaches 'finished' or 'skipped' — lets the
   *  caller (SalesBrainSection) refresh its own displayed status. */
  onDone?: () => void
}

/** M25 Phase 4 — the onboarding interview (spec section 3): a short,
 *  conversational setup that seeds business-scope memory on day one
 *  instead of waiting for 20 calls to build it up organically. Fixed
 *  question sequence (see onboarding.ts), skippable per-question or
 *  entirely, resumable (main process tracks progress), re-runnable from
 *  Settings → Sales Brain. */
export function OnboardingInterviewModal({ onClose, onDone }: OnboardingInterviewModalProps): React.JSX.Element {
  const [status, setStatus] = useState<OnboardingStatusResult | null>(null)
  const [answer, setAnswer] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    void window.api.salesBrain.onboarding.status().then((s) => {
      setStatus(s)
      if (s.status === 'finished' || s.status === 'skipped') onDone?.()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once on mount
  }, [])

  const submit = async (): Promise<void> => {
    if (!status?.nextTopic || submitting) return
    setSubmitting(true)
    try {
      const next = await window.api.salesBrain.onboarding.submitAnswer(status.nextTopic.id, answer)
      setAnswer('')
      setStatus(next)
      if (next.status === 'finished') onDone?.()
    } finally {
      setSubmitting(false)
    }
  }

  const skipTopic = async (): Promise<void> => {
    if (!status?.nextTopic || submitting) return
    setSubmitting(true)
    try {
      const next = await window.api.salesBrain.onboarding.skipTopic(status.nextTopic.id)
      setAnswer('')
      setStatus(next)
      if (next.status === 'finished') onDone?.()
    } finally {
      setSubmitting(false)
    }
  }

  const skipAll = async (): Promise<void> => {
    setSubmitting(true)
    try {
      await window.api.salesBrain.onboarding.skipAll()
      onDone?.()
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal onClose={onClose} title="Set up Sales Brain" size="md">
      <div className="flex items-center justify-between gap-4 border-b border-line-soft px-6 py-4">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-accent" />
          <div>
            <h2 className="text-sm font-semibold">Set up Sales Brain</h2>
            {status && (
              <p className="text-[12px] text-faint">
                {status.completedCount} of {status.totalCount} — takes a few minutes, skip anything you'd rather not answer
              </p>
            )}
          </div>
        </div>
        <IconButton icon={X} label="Close" onClick={onClose} />
      </div>

      <div className="px-6 py-5">
        {!status ? (
          <p className="text-[13px] text-faint">Loading…</p>
        ) : status.status === 'finished' ? (
          <div className="space-y-3 text-center">
            <p className="text-[14px] text-ink">All set — Sales Brain now knows the basics about your business.</p>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : status.nextTopic ? (
          <div className="space-y-4">
            <p className="text-[15px] leading-relaxed text-ink">{status.nextTopic.question}</p>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Type your answer…"
              rows={4}
              autoFocus
              disabled={submitting}
              className="w-full resize-none rounded-xl border border-line-soft bg-elevated px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent"
            />
            <div className="flex items-center justify-between">
              <Button
                variant="secondary"
                size="sm"
                icon={SkipForward}
                onClick={() => void skipTopic()}
                disabled={submitting}
              >
                Skip this question
              </Button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void skipAll()}
                  disabled={submitting}
                  className="text-[12px] text-faint underline-offset-2 hover:underline"
                >
                  Skip setup entirely
                </button>
                <Button
                  size="sm"
                  onClick={() => void submit()}
                  disabled={submitting || !answer.trim()}
                >
                  {submitting ? 'Saving…' : 'Next'}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
