import { useState } from 'react'
import { X, ShieldCheck, Check, Ban, RotateCcw } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Modal } from '@renderer/components/Modal'
import { IconButton } from '@renderer/components/IconButton'
import { Button } from '@renderer/components/Button'
import type { ConsentJurisdiction, ConsentMethod } from '@renderer/features/calls/types'
import type { ConsentController } from './useConsent'

const JURISDICTIONS: { value: ConsentJurisdiction; label: string }[] = [
  { value: 'two-party', label: 'Two-party' },
  { value: 'one-party', label: 'One-party' }
]

const METHODS: { value: ConsentMethod; label: string }[] = [
  { value: 'verbal-on-call', label: 'Verbal, on this call' },
  { value: 'pre-agreed', label: 'Agreed beforehand' },
  { value: 'written', label: 'In writing' }
]

interface ConsentModalProps {
  consent: ConsentController
  /** "They said yes": records consent AND opens buyer capture (a user gesture,
   *  required by getDisplayMedia). The parent wires this to useTranscription. */
  onEnable: (method: ConsentMethod) => void
  onClose: () => void
}

/** The consent gate + disclosure helper. Recording the other party can only be
 *  enabled from here, by recording an explicit "they said yes". */
export function ConsentModal({ consent, onEnable, onClose }: ConsentModalProps): React.JSX.Element {
  const { record } = consent
  const [method, setMethod] = useState<ConsentMethod>(record.method ?? 'verbal-on-call')
  const consented = consent.canRecord

  return (
    <Modal
      onClose={onClose}
      title="Record the other party?"
      size="md"
      className="max-h-[90vh] overflow-y-auto p-5"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-elevated">
            <ShieldCheck className="h-[18px] w-[18px] text-accent" strokeWidth={2} />
          </div>
          <h2 className="text-base font-semibold tracking-tight">Record the other party?</h2>
        </div>
        <IconButton icon={X} label="Close" onClick={onClose} />
      </div>

      <p className="mt-3 text-[13px] leading-relaxed text-muted">
        CallRise AI can transcribe the other person on the call — but only with their consent. Read
        the disclosure below, then record their answer. Recording the other party stays{' '}
        <span className="text-ink">off</span> until you confirm they said yes.
      </p>

      {/* Jurisdiction */}
      <div className="mt-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
          Consent rules where you are
        </p>
        <div className="mt-1.5 inline-flex rounded-lg border border-line p-0.5">
          {JURISDICTIONS.map((j) => (
            <button
              key={j.value}
              type="button"
              onClick={() => consent.setJurisdiction(j.value)}
              className={cn(
                'rounded-md px-3 py-1 text-[13px] font-medium transition',
                record.jurisdiction === j.value
                  ? 'bg-accent-soft text-ink'
                  : 'text-muted hover:text-ink'
              )}
            >
              {j.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-faint">
          Two-party regions need everyone&rsquo;s permission to record. When unsure, choose
          two-party.
        </p>
      </div>

      {/* Disclosure script */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
            Read this to your customer
          </p>
          <button
            type="button"
            onClick={consent.resetScript}
            className="flex items-center gap-1 text-[11px] text-faint transition hover:text-muted"
          >
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
        </div>
        <textarea
          value={consent.script}
          onChange={(e) => consent.setScript(e.target.value)}
          rows={3}
          className="mt-1.5 w-full resize-none rounded-lg border border-line-soft bg-canvas px-3 py-2 text-[13px] leading-relaxed text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
      </div>

      {/* Action area */}
      {consented ? (
        <div className="mt-4 rounded-xl border border-positive/30 bg-positive-soft p-3">
          <p className="flex items-center gap-2 text-[13px] font-medium text-positive">
            <Check className="h-4 w-4" /> Recording the other party is ON for this call.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2.5"
            onClick={() => {
              consent.turnOff()
              onClose()
            }}
          >
            Turn recording off
          </Button>
        </div>
      ) : (
        <div className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
            How was consent given?
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {METHODS.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setMethod(m.value)}
                className={cn(
                  'rounded-lg border px-2.5 py-1 text-[12px] font-medium transition',
                  method === m.value
                    ? 'border-accent/40 bg-accent-soft text-ink'
                    : 'border-line text-muted hover:text-ink'
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                // Synchronous in the click → getDisplayMedia stays a user gesture.
                onEnable(method)
                onClose()
              }}
              className="press flex flex-1 items-center justify-center gap-2 rounded-xl bg-positive-soft px-4 py-2.5 text-sm font-semibold text-positive ring-1 ring-inset ring-positive/30 transition hover:brightness-110"
            >
              <Check className="h-4 w-4" /> They said yes — enable recording
            </button>
            <Button
              variant="secondary"
              icon={Ban}
              onClick={() => {
                consent.markDeclined()
                onClose()
              }}
            >
              They said no
            </Button>
          </div>
        </div>
      )}

      {/* Honest guardrail */}
      <p className="mt-4 text-[11px] leading-relaxed text-faint">
        Consent laws vary by location — you&rsquo;re responsible for following the rules where you
        and your customer are.
      </p>
    </Modal>
  )
}
