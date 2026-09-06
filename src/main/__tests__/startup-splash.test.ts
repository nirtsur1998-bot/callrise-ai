// BUG-191 (M35 Stage 2 walk) — after the installer's Finish, a clean 4 GB
// machine showed NOTHING for about 35 seconds: no window, no taskbar entry.
// The main window is constructed only after every registration and several
// awaited loads, and then shown only on 'ready-to-show'. The fix is a splash
// that exists from the moment the app is ready until the real window is
// painted. This module is the controller, kept pure so the ordering is
// testable (index.ts itself cannot be imported by the suite).
import { describe, expect, it, vi } from 'vitest'
import { createStartupSplash } from '../startup-splash'

function harness(): {
  splash: ReturnType<typeof createStartupSplash>
  opened: number
  closed: number
  log: string[]
} {
  const state = { opened: 0, closed: 0, log: [] as string[] }
  const splash = createStartupSplash({
    open: () => {
      state.opened++
      state.log.push('open')
    },
    close: () => {
      state.closed++
      state.log.push('close')
    }
  })
  return {
    splash,
    get opened() {
      return state.opened
    },
    get closed() {
      return state.closed
    },
    log: state.log
  }
}

describe('startup splash — on screen from ready until the real window paints', () => {
  it('opens once when told the app is ready', () => {
    const h = harness()
    h.splash.appReady()
    expect(h.opened).toBe(1)
    expect(h.closed).toBe(0)
  })

  it('closes exactly once when the main window is ready to show, even if told twice', () => {
    const h = harness()
    h.splash.appReady()
    h.splash.mainWindowReady()
    h.splash.mainWindowReady()
    expect(h.log).toEqual(['open', 'close'])
  })

  it('never closes what it never opened: main ready before app ready is a no-op', () => {
    const h = harness()
    h.splash.mainWindowReady()
    expect(h.log).toEqual([])
    h.splash.appReady()
    // the real window is already up — do not flash a splash over it
    expect(h.log).toEqual([])
  })

  it('a failing open does not break the later close path', () => {
    const close = vi.fn()
    const splash = createStartupSplash({
      open: () => {
        throw new Error('no GPU')
      },
      close
    })
    expect(() => splash.appReady()).not.toThrow()
    splash.mainWindowReady()
    expect(close).not.toHaveBeenCalled()
  })

  it('reports its state honestly for the crash log', () => {
    const h = harness()
    expect(h.splash.state()).toBe('idle')
    h.splash.appReady()
    expect(h.splash.state()).toBe('shown')
    h.splash.mainWindowReady()
    expect(h.splash.state()).toBe('closed')
  })
})
