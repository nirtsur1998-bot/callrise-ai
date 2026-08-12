import { useEffect, useState } from 'react'
import { Brain, X } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import type { Memory } from '../../../../preload/index.d'

/** M25 Phase 5 — spec section 4: "Post-call toast: 'Sales Brain learned 3
 *  things from this call — Review', tap → review screen with accept/edit/
 *  dismiss per item." Triggered by memory-hooks.ts's native notification
 *  (main/memory-hooks.ts's notifyLearnedFromCall) via the
 *  'salesBrain:reviewRequested' event — a standalone app-level modal
 *  (not nested in CallDetail) so it works regardless of which page is
 *  currently active when the rep clicks the notification. */
export function MemoryReviewModal({ callId, onClose }: { callId: string; onClose: () => void }): React.JSX.Element {
  const [memories, setMemories] = useState<Memory[] | null>(null)

  useEffect(() => {
    void window.api.salesBrain.memories.byCall(callId).then(setMemories)
  }, [callId])

  const dismiss = async (id: string): Promise<void> => {
    await window.api.salesBrain.memories.delete(id)
    setMemories((prev) => prev?.filter((m) => m.id !== id) ?? null)
  }

  return (
    <Modal onClose={onClose} title="What Sales Brain learned" size="md">
      <div className="flex items-center justify-between gap-4 border-b border-line-soft px-6 py-4">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold">What Sales Brain learned from this call</h2>
        </div>
        <IconButton icon={X} label="Close" onClick={onClose} />
      </div>
      <div className="max-h-96 overflow-y-auto px-6 py-5">
        {!memories ? (
          <p className="py-4 text-center text-[13px] text-faint">Loading…</p>
        ) : memories.length === 0 ? (
          <p className="py-4 text-center text-[13px] text-faint">Nothing left to review — already handled.</p>
        ) : (
          <div className="space-y-3">
            {memories.map((m) => (
              <div key={m.id} className="flex items-start justify-between gap-3 rounded-xl border border-line-soft p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-ink">{m.statement}</p>
                  <p className="mt-1 text-[11px] text-faint">
                    {m.status === 'hypothesis' ? 'Noted — needs a few more calls to confirm' : 'Confirmed'} ·{' '}
                    {m.scope === 'rep' ? 'About you' : m.scope === 'business' ? 'Your business' : 'This client'}
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => void dismiss(m.id)}>
                  Dismiss
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
