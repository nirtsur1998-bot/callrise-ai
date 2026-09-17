// @vitest-environment happy-dom
//
// BUG-230 — a call recovered from a crash journal got no title, no summary
// and no brief, whatever the AI Note Taker toggles said: the three
// auto-behaviours lived inside useTranscription's save handler, and recovery
// (this prompt → live:recoverCall → saveCall in main) never goes through it.
//
// This mounts the REAL prompt inside the REAL Modal, clicks the real "Save
// this call" button, and asserts what happens to the recovered call's id.
// The link under test is the one BUG-227 taught this repo to check: not
// "does the sequence work" but "does THIS path call it".
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InterruptedCallPrompt } from '../InterruptedCallPrompt'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type NoteTaker = {
  autoSummarize: boolean
  autoGenerateTitle: boolean
  autoPostCallBrief: boolean
}

const RECOVERABLE = {
  id: 'journal-1',
  startedAt: '2026-09-17T09:00:00.000Z',
  durationMs: 95_000,
  segmentCount: 12,
  preview: 'Thanks for making the time today',
  truncated: false
}

function installMockApi(
  noteTaker: NoteTaker,
  recoverResult: { ok: boolean; call?: { id: string } } = {
    ok: true,
    call: { id: 'recovered-call-1' }
  }
): {
  recoverCall: ReturnType<typeof vi.fn>
  discardRecoverable: ReturnType<typeof vi.fn>
  generateTitle: ReturnType<typeof vi.fn>
  summarizeCall: ReturnType<typeof vi.fn>
  postCallBrief: ReturnType<typeof vi.fn>
  settingsGet: ReturnType<typeof vi.fn>
} {
  const recoverCall = vi.fn(async () => recoverResult)
  const discardRecoverable = vi.fn(async () => ({ ok: true }))
  const generateTitle = vi.fn(async () => ({ ok: true, jobId: 'job-1' }))
  const summarizeCall = vi.fn(async () => ({ ok: true }))
  const postCallBrief = vi.fn(async () => ({ ok: true, copied: true }))
  const settingsGet = vi.fn(async () => ({ aiNoteTaker: noteTaker }))
  ;(window as unknown as { api: unknown }).api = {
    live: {
      listRecoverable: vi.fn(async () => [RECOVERABLE]),
      recoverCall,
      discardRecoverable
    },
    settings: { get: settingsGet },
    calls: { generateTitle, summarizeCall, postCallBrief }
  }
  return {
    recoverCall,
    discardRecoverable,
    generateTitle,
    summarizeCall,
    postCallBrief,
    settingsGet
  }
}

let container: HTMLDivElement
let root: Root

async function mountAndWaitForPrompt(): Promise<void> {
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(InterruptedCallPrompt))
  })
  // listRecoverable resolves on a microtask; one more flush paints the modal.
  await act(async () => {
    await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(label)
  )
  if (!found) throw new Error(`no "${label}" button — the prompt did not render`)
  return found as HTMLButtonElement
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
  })
  // recoverCall → settings.get → the three dispatches: a few microtask turns.
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
  document.querySelectorAll('[role="dialog"]').forEach((el) => el.parentElement?.remove())
})

describe('InterruptedCallPrompt — a recovered call gets the AI Note Taker treatment (BUG-230)', () => {
  it('titles, summarizes and briefs the RECOVERED call when all three toggles are on', async () => {
    const mock = installMockApi({
      autoSummarize: true,
      autoGenerateTitle: true,
      autoPostCallBrief: true
    })
    await mountAndWaitForPrompt()
    await click('Save this call')

    expect(mock.recoverCall, 'the recovery itself').toHaveBeenCalledWith('journal-1')
    // The id is the saved CALL's, not the journal's — they are different ids.
    expect(mock.generateTitle).toHaveBeenCalledTimes(1)
    expect(mock.generateTitle).toHaveBeenCalledWith('recovered-call-1')
    expect(mock.summarizeCall).toHaveBeenCalledWith('recovered-call-1')
    expect(mock.postCallBrief).toHaveBeenCalledWith('recovered-call-1')
  })

  it('respects each toggle independently', async () => {
    const mock = installMockApi({
      autoSummarize: false,
      autoGenerateTitle: true,
      autoPostCallBrief: false
    })
    await mountAndWaitForPrompt()
    await click('Save this call')

    expect(mock.generateTitle).toHaveBeenCalledWith('recovered-call-1')
    expect(mock.summarizeCall).not.toHaveBeenCalled()
    expect(mock.postCallBrief).not.toHaveBeenCalled()
  })

  it('fires nothing when every toggle is off — and the settings WERE read', async () => {
    const mock = installMockApi({
      autoSummarize: false,
      autoGenerateTitle: false,
      autoPostCallBrief: false
    })
    await mountAndWaitForPrompt()
    await click('Save this call')

    // The companion work-count: without it, "nothing fired" is also what a
    // path that never reached the gate looks like.
    expect(mock.settingsGet).toHaveBeenCalledTimes(1)
    expect(mock.generateTitle).not.toHaveBeenCalled()
    expect(mock.summarizeCall).not.toHaveBeenCalled()
    expect(mock.postCallBrief).not.toHaveBeenCalled()
  })

  it('a recovery that produced no call fires nothing and reads no settings', async () => {
    const mock = installMockApi(
      { autoSummarize: true, autoGenerateTitle: true, autoPostCallBrief: true },
      { ok: false }
    )
    await mountAndWaitForPrompt()
    await click('Save this call')

    expect(mock.recoverCall).toHaveBeenCalledTimes(1)
    expect(mock.settingsGet).not.toHaveBeenCalled()
    expect(mock.generateTitle).not.toHaveBeenCalled()
  })

  it('discarding a call never touches the AI Note Taker', async () => {
    const mock = installMockApi({
      autoSummarize: true,
      autoGenerateTitle: true,
      autoPostCallBrief: true
    })
    await mountAndWaitForPrompt()
    await click('Discard')

    expect(mock.discardRecoverable).toHaveBeenCalledWith('journal-1')
    expect(mock.settingsGet).not.toHaveBeenCalled()
    expect(mock.generateTitle).not.toHaveBeenCalled()
  })
})
