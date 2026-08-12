import { useEffect, useState } from 'react'
import { Brain, BrainCog } from 'lucide-react'
import { Button } from '@renderer/components/Button'

/** M25 Phase 5 — spec section 4's "Don't learn from this call" toggle
 *  (retroactive half; CallDetail.tsx). Only rendered when Sales Brain is on
 *  — the caller checks that, this component doesn't duplicate the check.
 *  Turning it ON deletes any memories already extracted from this call
 *  (main process's job, see memory-center-ipc.ts's setExcluded handler) —
 *  this component just reflects and toggles the flag. */
export function SalesBrainCallToggle({ callId }: { callId: string }): React.JSX.Element | null {
  const [excluded, setExcluded] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.salesBrain.calls.getExcluded(callId).then(setExcluded)
  }, [callId])

  if (excluded === null) return null

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.salesBrain.calls.setExcluded(callId, !excluded)
      setExcluded(!excluded)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      icon={excluded ? BrainCog : Brain}
      onClick={() => void toggle()}
      disabled={busy}
    >
      {excluded ? "Sales Brain won't learn from this call" : 'Sales Brain is learning from this call'}
    </Button>
  )
}
