import { useCallback, useState } from 'react'
import { getAutoStartListening, setAutoStartListening } from './prefs'

export function useAutoStartListening(): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => getAutoStartListening())

  const update = useCallback((next: boolean) => {
    setAutoStartListening(next)
    setValue(next)
  }, [])

  return [value, update]
}
