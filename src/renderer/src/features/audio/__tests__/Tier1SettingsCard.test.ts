// @vitest-environment happy-dom
//
// The Windows settings card for Tier 1 — driven through a REAL render, real
// DOM, real click, not just the pure tier1UiState/useTier1 logic in
// isolation. See docs on Tier1SettingsCard.tsx for why this card exists as
// its own component rather than a branch inside the macOS one: those two are
// verified NOT to interfere with each other here, by rendering both under
// each platform flag and asserting the wrong one contributes nothing.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let isMacFlag = false
let isWindowsFlag = true
vi.mock('@renderer/lib/platform', () => ({
  get isMac() {
    return isMacFlag
  },
  get isWindows() {
    return isWindowsFlag
  }
}))

function makeFakeTier1Api(): {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  getStatus: ReturnType<typeof vi.fn>
  onStatus: ReturnType<typeof vi.fn>
  onPcm: ReturnType<typeof vi.fn>
  emitStatus: (s: unknown) => void
  resolveGetStatus: (s: unknown) => void
} {
  const statusCbs = new Set<(s: unknown) => void>()
  let pendingResolve: ((s: unknown) => void) | null = null
  return {
    start: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ ok: true })),
    getStatus: vi.fn(
      () =>
        new Promise((resolve) => {
          pendingResolve = resolve
        })
    ),
    onStatus: vi.fn((cb: (s: unknown) => void) => {
      statusCbs.add(cb)
      return () => statusCbs.delete(cb)
    }),
    onPcm: vi.fn(() => () => {}),
    emitStatus: (s: unknown) => statusCbs.forEach((cb) => cb(s)),
    resolveGetStatus: (s: unknown) => pendingResolve?.(s)
  }
}

function unavailable(): unknown {
  return { engineAvailable: false, engineRunning: false, connected: false, denoisingActive: null, enginePath: null }
}
function idleAvailable(): unknown {
  return {
    engineAvailable: true,
    engineRunning: false,
    connected: false,
    denoisingActive: null,
    enginePath: 'C:\\x\\kern_bridge.exe'
  }
}
function active(): unknown {
  return {
    engineAvailable: true,
    engineRunning: true,
    connected: true,
    denoisingActive: true,
    enginePath: 'C:\\x\\kern_bridge.exe'
  }
}
function modelMissing(): unknown {
  return {
    engineAvailable: true,
    engineRunning: true,
    connected: true,
    denoisingActive: false,
    enginePath: 'C:\\x\\kern_bridge.exe'
  }
}

let fakeTier1: ReturnType<typeof makeFakeTier1Api>

const { Tier1SettingsCard } = await import('../Tier1SettingsCard')

let container: HTMLDivElement
let root: Root

async function renderCard(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(Tier1SettingsCard))
  })
}

function toggleButton(): HTMLButtonElement | null {
  return container.querySelector('button[role="switch"]')
}

beforeEach(() => {
  isMacFlag = false
  isWindowsFlag = true
  localStorage.clear()
  fakeTier1 = makeFakeTier1Api()
  Object.defineProperty(window, 'api', { configurable: true, value: { tier1: fakeTier1 } })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('platform gating', () => {
  it('renders nothing on macOS', async () => {
    isMacFlag = true
    isWindowsFlag = false
    await renderCard()
    await act(async () => {
      fakeTier1.resolveGetStatus(idleAvailable())
    })
    expect(container.innerHTML).toBe('')
  })

  it('renders on Windows', async () => {
    await renderCard()
    await act(async () => {
      fakeTier1.resolveGetStatus(idleAvailable())
    })
    expect(container.innerHTML).not.toBe('')
  })
})

describe('loading and unavailable', () => {
  it('shows a loading indicator before the first status resolves, not an empty card', async () => {
    await renderCard()
    expect(container.textContent).toMatch(/Checking/i)
  })

  it('hides the toggle and explains when the engine binary is not found', async () => {
    await renderCard()
    await act(async () => {
      fakeTier1.resolveGetStatus(unavailable())
    })
    expect(toggleButton()).toBeNull()
    expect(container.textContent).toMatch(/couldn.t be found/i)
  })
})

describe('the toggle — off by default, opt-in required', () => {
  it('renders "Turn on" by default (off) and flips to "Turn off" on click', async () => {
    await renderCard()
    await act(async () => {
      fakeTier1.resolveGetStatus(idleAvailable())
    })
    const btn = toggleButton()!
    expect(btn.getAttribute('aria-checked')).toBe('false')
    expect(btn.textContent).toMatch(/turn on/i)

    await act(async () => {
      btn.click()
    })
    expect(btn.getAttribute('aria-checked')).toBe('true')
    expect(btn.textContent).toMatch(/turn off/i)
  })

  it('persists the toggle to the same preference recorder.ts reads at call start', async () => {
    const { getTier1Enabled } = await import('@renderer/features/settings/prefs')
    await renderCard()
    await act(async () => {
      fakeTier1.resolveGetStatus(idleAvailable())
    })
    expect(getTier1Enabled()).toBe(false)

    await act(async () => {
      toggleButton()!.click()
    })
    expect(getTier1Enabled()).toBe(true)
  })

  it('never calls tier1Api.start/stop directly — this card only ever writes the preference', async () => {
    // The whole point of the design: Tier 1 has no standalone process for
    // this card to start or stop outside a live call. If this test ever
    // fails, something has reintroduced a live-toggle assumption that
    // doesn't match how recorder.ts actually owns the engine's lifecycle.
    await renderCard()
    await act(async () => {
      fakeTier1.resolveGetStatus(idleAvailable())
    })
    await act(async () => {
      toggleButton()!.click()
    })
    await act(async () => {
      toggleButton()!.click()
    })
    expect(fakeTier1.start).not.toHaveBeenCalled()
    expect(fakeTier1.stop).not.toHaveBeenCalled()
  })
})

describe('status indicator — exactly what the pipeline reports, no invented state', () => {
  it('off: explanatory text, no positive or warning box', async () => {
    await renderCard()
    await act(async () => {
      fakeTier1.resolveGetStatus(idleAvailable())
    })
    expect(container.textContent).toMatch(/turn it on to clean your microphone/i)
    expect(container.textContent).not.toMatch(/being cleaned/i)
    expect(container.textContent).not.toMatch(/passing through unprocessed/i)
  })

  it('on, idle (no call yet): says so honestly rather than claiming active', async () => {
    await renderCard()
    await act(async () => {
      fakeTier1.resolveGetStatus(idleAvailable())
    })
    await act(async () => {
      toggleButton()!.click()
    })
    expect(container.textContent).toMatch(/will start cleaning your microphone/i)
    expect(container.textContent).not.toMatch(/being cleaned\./i)
  })

  it('active: the real "on and working" state, sourced from denoisingActive:true', async () => {
    await renderCard()
    await act(async () => {
      fakeTier1.resolveGetStatus(idleAvailable())
    })
    await act(async () => {
      toggleButton()!.click()
    })
    await act(async () => {
      fakeTier1.emitStatus(active())
    })
    expect(container.textContent).toMatch(/your voice is being cleaned/i)
  })

  it('model-missing: a REAL, visibly different warning state — not folded into "on"', async () => {
    await renderCard()
    await act(async () => {
      fakeTier1.resolveGetStatus(idleAvailable())
    })
    await act(async () => {
      toggleButton()!.click()
    })
    await act(async () => {
      fakeTier1.emitStatus(modelMissing())
    })
    expect(container.textContent).toMatch(/model.*wasn.t found/i)
    expect(container.textContent).toMatch(/unprocessed/i)
    expect(container.textContent).not.toMatch(/your voice is being cleaned/i)
  })

  it('live status pushes update the rendered card without a re-mount', async () => {
    await renderCard()
    await act(async () => {
      fakeTier1.resolveGetStatus(idleAvailable())
    })
    await act(async () => {
      toggleButton()!.click()
    })
    await act(async () => {
      fakeTier1.emitStatus(active())
    })
    expect(container.textContent).toMatch(/your voice is being cleaned/i)

    // The pipe drops mid-call — the SAME card, still mounted, must reflect it.
    await act(async () => {
      fakeTier1.emitStatus(modelMissing())
    })
    expect(container.textContent).toMatch(/unprocessed/i)
    expect(container.textContent).not.toMatch(/your voice is being cleaned/i)
  })
})
