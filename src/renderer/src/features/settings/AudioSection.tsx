import { Card } from '@renderer/components/Card'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { NoiseCancellationCard } from '@renderer/features/audio/NoiseCancellationCard'
import { useAutoStartListening } from './useAutoStartListening'
import { SettingRow } from './SettingRow'

export function AudioSection(): React.JSX.Element {
  const [autoStart, setAutoStart] = useAutoStartListening()

  return (
    <>
      <Card className="mb-5">
        <SettingRow
          title="Auto-start listening"
          description="Start transcription automatically when you open Live Calls, instead of clicking Start yourself. You can still stop, pause, or restart manually at any time."
          control={
            <ToggleSwitch
              checked={autoStart}
              onChange={setAutoStart}
              label="Auto-start listening"
            />
          }
        />
      </Card>

      <NoiseCancellationCard />
    </>
  )
}
