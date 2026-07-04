import { useCallback, useEffect, useRef, useState } from 'react'

// Derive the status shape straight from the preload bridge so it can never
// drift from what the main process actually returns.
export type VirtualMicStatus = Awaited<ReturnType<typeof window.api.virtualmic.getStatus>>

export interface UseVirtualMic {
  status: VirtualMicStatus | null
  busy: boolean
  /** Start the denoiser helper. */
  start: () => Promise<void>
  /** Stop the denoiser helper. */
  stop: () => Promise<void>
}

/**
 * App-managed noise cancellation: reads whether the virtual-mic driver/helper
 * are available and whether denoising is running, live-updates on the helper's
 * state changes (including if it crashes), and drives the on/off toggle.
 */
export function useVirtualMic(): UseVirtualMic {
  const [status, setStatus] = useState<VirtualMicStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    void window.api.virtualmic.getStatus().then((s) => {
      if (mountedRef.current) setStatus(s)
    })
    const unsub = window.api.virtualmic.onChanged((s) => {
      if (mountedRef.current) setStatus(s as VirtualMicStatus)
    })
    return () => {
      mountedRef.current = false
      unsub()
    }
  }, [])

  const refresh = useCallback(async () => {
    const s = await window.api.virtualmic.getStatus()
    if (mountedRef.current) setStatus(s)
  }, [])

  const start = useCallback(async () => {
    setBusy(true)
    try {
      await window.api.virtualmic.start()
      await refresh()
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [refresh])

  const stop = useCallback(async () => {
    setBusy(true)
    try {
      await window.api.virtualmic.stop()
      await refresh()
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [refresh])

  return { status, busy, start, stop }
}
