// @vitest-environment happy-dom
//
// BUG-271, the half the rep sees. A failed rescue used to look exactly like a
// successful one: the prompt advanced to the next call (or closed) either way,
// and a rep whose 40-minute call had NOT been saved was told nothing.
//
// Real prompt, real Modal, real button clicks; only `window.api` is faked.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InterruptedCallPrompt } from '../InterruptedCallPrompt'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RECOVERABLE = {
  id: 'journal-1',
  startedAt: '2026-09-17T09:00:00.000Z',
  durationMs: 95_000,
  segmentCount: 12,
  preview: 'Thanks for making the time today',
  truncated: false
}

type RecoverResult =
  | { ok: true; call: { id: string }; degraded: string[] }
  | { ok: false; reason: 'nothing-to-recover' | 'bad-request' }
  | { ok: false; reason: 'step-failed'; step: string; message: string }

function installMockApi(results: Array<RecoverResult | Error>): {
  recoverCall: ReturnType<typeof vi.fn>
  generateTitle: ReturnType<typeof vi.fn>
} {
  const queue = [...results]
  const recoverCall = vi.fn(async () => {
    const next = queue.shift()
    if (next instanceof Error) throw next
    if (!next) throw new Error('test asked for more recoveries than it scripted')
    return next
  })
  const generateTitle = vi.fn(async () => ({ ok: true, jobId: 'job-1' }))
  ;(window as unknown as { api: unknown }).api = {
    live: {
      listRecoverable: vi.fn(async () => [RECOVERABLE]),
      recoverCall,
      discardRecoverable: vi.fn(async () => ({ ok: true }))
    },
    settings: {
      get: vi.fn(async () => ({
        aiNoteTaker: { autoSummarize: false, autoGenerateTitle: true, autoPostCallBrief: false }
      }))
    },
    calls: {
      generateTitle,
      summarizeCall: vi.fn(async () => ({ ok: true })),
      postCallBrief: vi.fn(async () => ({ ok: true, copied: false }))
    }
  }
  return { recoverCall, generateTitle }
}

let container: HTMLDivElement
let root: Root

async function mount(): Promise<void> {
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(InterruptedCallPrompt))
  })
  await act(async () => {
    await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(label)
  ) as HTMLButtonElement | undefined
}

async function click(label: string): Promise<void> {
  const el = button(label)
  if (!el) throw new Error(`no "${label}" button on screen`)
  await act(async () => {
    el.click()
  })
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

const alertText = (): string | null =>
  document.querySelector('[role="alert"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null
const dialogOpen = (): boolean => document.querySelector('[role="dialog"]') !== null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
  document.querySelectorAll('[role="dialog"]').forEach((el) => el.parentElement?.remove())
})

describe('InterruptedCallPrompt — a failed rescue is SAID, not swallowed (BUG-271)', () => {
  it('a failed save keeps the prompt on this call and says which step failed', async () => {
    const mock = installMockApi([
      { ok: false, reason: 'step-failed', step: 'save', message: 'ENOSPC: no space left' }
    ])
    await mount()
    await click('Save this call')

    expect(dialogOpen(), 'the prompt must NOT advance past an unsaved call').toBe(true)
    expect(alertText()).toContain('This call was not saved.')
    expect(alertText()).toContain('could not be written to your call list')
    // The reassurance every failure shares: nothing was destroyed.
    expect(alertText()).toContain('Nothing was deleted')
    // A call that was not saved gets no AI work done on it.
    expect(mock.generateTitle).not.toHaveBeenCalled()
  })

  it('different steps read differently — the whole point of naming them', async () => {
    installMockApi([
      { ok: false, reason: 'step-failed', step: 'read-journal', message: 'EIO' },
      { ok: false, reason: 'step-failed', step: 'save', message: 'ENOSPC' },
      { ok: false, reason: 'step-failed', step: 'read-call', message: 'EIO' }
    ])
    await mount()
    await click('Save this call')
    const first = alertText()
    await click('Try again')
    const second = alertText()
    await click('Try again')
    const third = alertText()

    expect(first).toContain('could not be read from disk')
    expect(second).toContain('could not be written to your call list')
    // The saved COPY could not be opened — not the recording. A rep told the
    // recording was unreadable would look for the wrong thing.
    expect(third).toContain('already saved once')
    expect(third).not.toContain('recording')
    expect(new Set([first, second, third]).size).toBe(3)
  })

  it('"Try again" that succeeds clears the warning, advances, and titles the call', async () => {
    const mock = installMockApi([
      { ok: false, reason: 'step-failed', step: 'save', message: 'ENOSPC' },
      { ok: true, call: { id: 'recovered-call-1' }, degraded: [] }
    ])
    await mount()
    await click('Save this call')
    expect(button('Try again'), 'the button says what it now does').toBeDefined()

    await click('Try again')

    expect(mock.recoverCall).toHaveBeenCalledTimes(2)
    expect(dialogOpen()).toBe(false)
    expect(mock.generateTitle).toHaveBeenCalledWith('recovered-call-1')
  })

  it('an IPC call that throws is a named failure too, not a silent advance', async () => {
    installMockApi([new Error('ipc channel closed')])
    await mount()
    await click('Save this call')

    expect(dialogOpen()).toBe(true)
    expect(alertText()).toContain('Something unexpected went wrong')
  })

  it('a SAVED call whose tidy-up stumbled is a success: no warning, and it is titled', async () => {
    const mock = installMockApi([
      { ok: true, call: { id: 'recovered-call-1' }, degraded: ['mark-recovered'] }
    ])
    await mount()
    await click('Save this call')

    expect(dialogOpen()).toBe(false)
    expect(mock.generateTitle).toHaveBeenCalledWith('recovered-call-1')
  })

  it('"nothing to recover" advances quietly — there is nothing to warn about', async () => {
    installMockApi([{ ok: false, reason: 'nothing-to-recover' }])
    await mount()
    await click('Save this call')

    expect(dialogOpen()).toBe(false)
  })

  it('"Decide later" still works from the failed state', async () => {
    installMockApi([{ ok: false, reason: 'step-failed', step: 'save', message: 'ENOSPC' }])
    await mount()
    await click('Save this call')
    await click('Decide later')

    expect(dialogOpen()).toBe(false)
  })
})
