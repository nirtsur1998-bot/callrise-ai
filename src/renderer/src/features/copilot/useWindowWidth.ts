// BUG-171 — the window's inner width, live. One listener, one state; the
// value only changes when the width does, so a height-only resize (the
// overlay strip, a taskbar) re-renders nothing.
import { useEffect, useState } from 'react'

export function useWindowWidth(): number {
  const [width, setWidth] = useState<number>(() => window.innerWidth)
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    onResize() // the width at mount, in case it moved between render and effect
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}
