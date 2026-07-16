import { useCallback, useState } from 'react'
import { getAutoTranscribeCalls, setAutoTranscribeCalls } from './prefs'

export function useAutoTranscribeCalls(): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => getAutoTranscribeCalls())

  const update = useCallback((next: boolean) => {
    setAutoTranscribeCalls(next)
    setValue(next)
  }, [])

  return [value, update]
}
