import { useCallback, useState } from 'react'
import { Card } from '@renderer/components/Card'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { ReviewQueueView } from '@renderer/features/objection-library/ReviewQueueView'
import { ScanPastCallsCard } from '@renderer/features/objection-library/ScanPastCallsCard'
import { useAppSettings } from './useAppSettings'
import { SettingRow } from './SettingRow'

/**
 * Step 1: the master switch, off by default — the ONLY gate for whether any
 * call transcript is ever read for objection mining. Step 4 adds automatic
 * mining of NEW calls (wired into calls:save, gated on this same toggle) and
 * the manual "scan past calls" trigger below, for calls saved before the
 * toggle was turned on. Step 3's review queue is still the only path from a
 * mined suggestion to a real script.
 */
export function ObjectionLibrarySection(): React.JSX.Element {
  const { settings, update } = useAppSettings()
  const enabled = settings.objectionMining.enabled
  // Bumped when a scan adds suggestions, so the review queue below reloads
  // instead of showing its stale mount-time list.
  const [queueVersion, setQueueVersion] = useState(0)
  const onQueueChanged = useCallback(() => setQueueVersion((v) => v + 1), [])

  return (
    <>
      <Card className="mb-5">
        <SettingRow
          title="Learn objection responses from my calls"
          description="When on, AI reads new call transcripts for objections you handled and suggests them as reusable scripts. You review and approve every suggestion — nothing is added automatically, and nothing reaches live coaching cues without your approval."
          control={
            <ToggleSwitch
              checked={enabled}
              onChange={(next) => void update({ objectionMining: { enabled: next } })}
              label="Learn objection responses from my calls"
            />
          }
        />
        <p className="mt-4 border-t border-line-soft pt-4 text-[12px] text-faint">
          Off by default. While off, this feature does nothing in the background — it only runs when
          you turn it on, and even then only proposes suggestions for you to review.
        </p>
      </Card>

      <Card className="mb-5">
        <h3 className="mb-1 text-sm font-semibold">Scan my past calls</h3>
        <p className="mb-4 text-[12px] text-muted">
          Calls saved while this was off were never mined. This is a one-time, manual catch-up — it
          only runs when you click the button, never automatically.
        </p>
        <ScanPastCallsCard enabled={enabled} onQueueChanged={onQueueChanged} />
      </Card>

      <Card className="mb-5">
        <h3 className="mb-1 text-sm font-semibold">Review queue</h3>
        <p className="mb-4 text-[12px] text-muted">
          Suggestions mined from your calls, waiting for your decision. Nothing here is a real
          script yet — approve, edit then approve, or reject each one.
        </p>
        <ReviewQueueView refreshToken={queueVersion} />
      </Card>
    </>
  )
}
