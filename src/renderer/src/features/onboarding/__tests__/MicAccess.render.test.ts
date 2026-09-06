// @vitest-environment happy-dom
//
// BUG-190 — the wizard's microphone step, mounted for real. On the Stage 2
// clean-machine walk (no audio input device) this step said "Microphone
// access wasn't granted" and offered "Open OS settings"; the stranger went to
// Windows privacy settings, where nothing was wrong. The step must say what
// happened and offer the settings link ONLY when permission is the problem.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MicAccess } from '../steps/MicAccess'
import type { OnboardingState } from '../useOnboarding'

class FakeDOMException extends Error {
  constructor(name: string, message = '') {
    super(message)
    this.name = name
  }
}

function fakeState(): { o: OnboardingState; outcomes: Array<string | null> } {
  const outcomes: Array<string | null> = []
  const o = {
    micOutcome: null,
    setMicOutcome: (v: string | null) => outcomes.push(v)
  } as unknown as OnboardingState
  return { o, outcomes }
}

async function mountAndRequest(rejectWith: unknown): Promise<{ container: HTMLDivElement; root: Root; outcomes: Array<string | null> }> {
  const { o, outcomes } = fakeState()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(createElement(MicAccess, { o })))
  const button = Array.from(container.querySelectorAll('button')).find((b) => /Grant microphone access/.test(b.textContent ?? ''))
  expect(button, 'the request button').toBeTruthy()
  await act(async () => {
    button!.click()
    await Promise.resolve()
    await Promise.resolve()
  })
  void rejectWith
  return { container, root, outcomes }
}

describe('MicAccess — what a failed request is called', () => {
  let roots: Root[] = []
  beforeEach(() => {
    roots = []
    ;(globalThis as { window: unknown }).window = globalThis
    ;(window as unknown as { api: unknown }).api = {
      transcription: {
        ensureMicAccess: vi.fn(async () => ({ status: 'granted' })),
        openMicSettings: vi.fn(async () => undefined)
      }
    }
  })
  afterEach(() => {
    for (const r of roots) act(() => r.unmount())
    document.body.innerHTML = ''
  })

  it('no device: says "No microphone found", never mentions privacy settings, no OS-settings link', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => { throw new FakeDOMException('NotFoundError', 'Requested device not found') }) }
    })
    const { container, root, outcomes } = await mountAndRequest(null)
    roots.push(root)
    const text = container.textContent ?? ''
    expect(text).toContain('No microphone found')
    expect(text).not.toContain("wasn't granted")
    expect(text).not.toMatch(/privacy settings/i)
    expect(text).not.toContain('Open OS settings')
    expect(text).not.toContain('Requested device not found')
    expect(outcomes).toEqual(['no-device'])
  })

  it('permission refused: says so and DOES offer the OS-settings link', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => { throw new FakeDOMException('NotAllowedError') }) }
    })
    const { container, root, outcomes } = await mountAndRequest(null)
    roots.push(root)
    const text = container.textContent ?? ''
    expect(text).toContain("Microphone access wasn't granted")
    expect(text).toContain('Open OS settings')
    expect(outcomes).toEqual(['denied'])
  })

  it('granted: reports ok to the wizard state', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) }
    })
    const { container, root, outcomes } = await mountAndRequest(null)
    roots.push(root)
    expect(container.textContent).toContain('Microphone access granted')
    expect(outcomes).toEqual(['ok'])
  })
})
