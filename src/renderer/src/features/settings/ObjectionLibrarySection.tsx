import { Card } from '@renderer/components/Card'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { ReviewQueueView } from '@renderer/features/objection-library/ReviewQueueView'
import { useAppSettings } from './useAppSettings'
import { SettingRow } from './SettingRow'

/**
 * Step 1 of the Objection Library milestone: the master switch, off by
 * default. This is the ONLY gate — while off, no call transcript is ever
 * read for objection mining (not new calls, not a future manual "scan past
 * calls" trigger). Step 3 adds the review queue below — the human-in-the-loop
 * gate every mined candidate must pass before it becomes a real script.
 */
export function ObjectionLibrarySection(): React.JSX.Element {
  const { settings, update } = useAppSettings()
  const enabled = settings.objectionMining.enabled

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
          Off by default. While off, this feature does nothing in the background — it only runs
          when you turn it on, and even then only proposes suggestions for you to review.
        </p>
      </Card>

      <Card className="mb-5">
        <h3 className="mb-1 text-sm font-semibold">Review queue</h3>
        <p className="mb-4 text-[12px] text-muted">
          Suggestions mined from your calls, waiting for your decision. Nothing here is a real
          script yet — approve, edit then approve, or reject each one.
        </p>
        <ReviewQueueView />
      </Card>
    </>
  )
}
