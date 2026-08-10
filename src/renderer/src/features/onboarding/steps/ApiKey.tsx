import { useEffect, useState } from 'react'
import { KeyCard, DEEPGRAM_KEY_CONFIG } from '@renderer/features/settings/ApiKeysSection'
import { StepHeader } from './StepHeader'

type DeepgramStatus = Awaited<ReturnType<typeof window.api.aiKeys.getStatus>>['DEEPGRAM_API_KEY']

/** Step: get the one key that's actually required for a first call to work
 *  (Deepgram, live transcription) — reuses Settings' own KeyCard so save/
 *  test/clear behavior can never drift between the two places. Text-AI
 *  provider keys (summaries/coaching) stay Settings-only: useful but not
 *  blocking, and listing all 8 here would turn one step into its own flow. */
export function ApiKey(): React.JSX.Element {
  const [status, setStatus] = useState<DeepgramStatus | undefined>(undefined)

  const refresh = (): void => {
    void window.api.aiKeys.getStatus().then((s) => setStatus(s.DEEPGRAM_API_KEY))
  }
  useEffect(refresh, [])

  return (
    <div>
      <StepHeader
        title="Add your Deepgram key"
        subtitle="Live transcription needs this to turn your voice into text during a call. Free to get, takes a minute — or skip and add it later in Settings."
      />
      <KeyCard config={DEEPGRAM_KEY_CONFIG} status={status} onChanged={refresh} />
    </div>
  )
}
