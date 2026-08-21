// @vitest-environment happy-dom
// Audit fix V2 — the blank first turn. A brand-new conversation's first
// message must go through the hook's own send (optimistic bubbles, live
// deltas, Stop available) instead of a fire-and-forget IPC call the hook
// never sees. Renders the REAL hook via react-dom, same precedent as
// useTranscription.unmount-save.test.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import { useAssistantChat, type UseAssistantChat, type AssistantChatOptions } from '../useAssistantChat'

// happy-dom + act plumbing
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const api = {
  sendCalls: [] as unknown[][],
  resolveSend: (_v: unknown) => {},
  deltaCb: null as ((p: unknown) => void) | null,
  conversation: { id: 'conv-1', title: 'x', createdAt: 'x', updatedAt: 'x', messages: [] as unknown[] }
}

beforeEach(() => {
  api.sendCalls = []
  api.deltaCb = null
  api.conversation = { id: 'conv-1', title: 'x', createdAt: 'x', updatedAt: 'x', messages: [] }
  ;(window as unknown as Record<string, unknown>).api = {
    assistant: {
      getConversation: vi.fn(async () => api.conversation),
      attach: vi.fn(async () => ({ streaming: false, accumulated: '', pendingUserText: '' })),
      send: vi.fn((...args: unknown[]) => {
        api.sendCalls.push(args)
        return new Promise((resolve) => {
          api.resolveSend = resolve
        })
      }),
      cancel: vi.fn(async () => true),
      discardVoiceNote: vi.fn(async () => true),
      onDelta: (cb: (p: unknown) => void) => {
        api.deltaCb = cb
        return () => {}
      },
      onError: () => () => {},
      onTurnComplete: () => () => {},
      onPhase: () => () => {}
    }
  }
})

let latest: UseAssistantChat | null = null

function Probe({ options }: { options?: AssistantChatOptions }): null {
  latest = useAssistantChat('conv-1', options)
  return null
}

async function mount(options?: AssistantChatOptions): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(Probe, { options }))
  })
  // let the load effect's async body settle
  await act(async () => {
    await Promise.resolve()
  })
  return root
}

describe('useAssistantChat — first turn of a new conversation (audit V2)', () => {
  it('sends the initial message through the hook: optimistic bubbles + live deltas + sending=true', async () => {
    await mount({ initialMessage: { text: 'What do you know about my business?' } })

    // The send went out through the hook, exactly once.
    expect(api.sendCalls).toHaveLength(1)
    expect(api.sendCalls[0][0]).toBe('conv-1')
    expect(api.sendCalls[0][1]).toBe('What do you know about my business?')

    // BEFORE the invoke resolves: both bubbles visible, streaming, Stop-able.
    expect(latest!.sending).toBe(true)
    expect(latest!.messages).toHaveLength(2)
    expect(latest!.messages[0].role).toBe('user')
    expect(latest!.messages[0].text).toBe('What do you know about my business?')
    expect(latest!.messages[1].streaming).toBe(true)

    // A delta lands in the streaming bubble live.
    await act(async () => {
      api.deltaCb?.({ conversationId: 'conv-1', delta: 'Your business ' })
    })
    expect(latest!.messages[1].text).toBe('Your business ')
  })

  it('does not fire for a conversation that already has messages', async () => {
    api.conversation.messages = [
      { id: 'm1', role: 'user', text: 'old', createdAt: 'x' },
      { id: 'm2', role: 'assistant', text: 'old reply', createdAt: 'x' }
    ]
    await mount({ initialMessage: { text: 'should not send' } })
    expect(api.sendCalls).toHaveLength(0)
  })

  it('carries the voice note instead of discarding it', async () => {
    await mount({
      initialMessage: { text: 'dictated', voiceNote: { mediaId: 'a-1.webm', durationMs: 900 } }
    })
    expect(api.sendCalls[0][2]).toEqual({ mediaId: 'a-1.webm', durationMs: 900 })
  })
})
