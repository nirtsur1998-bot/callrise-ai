// @vitest-environment happy-dom
//
// BUG-252 — a conversation switch must discard the whole hook instance.
//
// `useAssistantChat` owns seven pieces of per-conversation state and its reset
// effect writes three of them. `scope` and `learningExcluded` are set only
// AFTER `await Promise.all([getConversation, attach])` resolves, so while that
// IPC is in flight the previous conversation's values are still on screen —
// including the scope chip, whose tooltip reads "This conversation is only
// about <name>". A UI string asserting a scope it is not describing.
//
// The fix is structural: the pane is a component keyed on the conversation id,
// so React throws the instance away. This file pins BOTH halves, because
// either alone is hollow:
//
//   1. BEHAVIOUR — the keyed caller clears scope on switch and the unkeyed one
//      does not. The unkeyed case is asserted deliberately: it is the bug,
//      reproduced, so a future reader can see what the key is buying.
//   2. THE WIRING — `AssistantView` actually passes that key. A behavioural
//      test of a keyed Probe proves React works, not that this app uses it.
//
// Renders the REAL hook via react-dom, same precedent as
// useAssistantChat.firstTurn.test.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import { useAssistantChat, type UseAssistantChat } from '../useAssistantChat'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

type Conv = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: unknown[]
  scope?: { contactId: string; contactName: string } | null
  salesBrainExcluded?: boolean
}

/** Conversation A is scoped to a client; B is not. The gap between the switch
 *  and B's record arriving is the whole window this bug lives in, so the IPC
 *  is held open by hand rather than resolved immediately. */
const CONVS: Record<string, Conv> = {
  'conv-a': {
    id: 'conv-a',
    title: 'About the Nabbit account',
    createdAt: 'x',
    updatedAt: 'x',
    messages: [],
    scope: { contactId: 'c1', contactName: 'Client A' },
    salesBrainExcluded: true
  },
  'conv-b': { id: 'conv-b', title: 'Something else', createdAt: 'x', updatedAt: 'x', messages: [] }
}

let releaseGet: (() => void) | null = null

beforeEach(() => {
  releaseGet = null
  ;(window as unknown as Record<string, unknown>).api = {
    assistant: {
      getConversation: vi.fn(
        (id: string) =>
          new Promise<Conv | null>((resolve) => {
            // A's record lands at once; B's is held, so the test can inspect
            // the frame that used to show A's scope over B.
            if (id === 'conv-a') resolve(CONVS['conv-a'] ?? null)
            else releaseGet = () => resolve(CONVS[id] ?? null)
          })
      ),
      attach: vi.fn(async () => ({ streaming: false, accumulated: '', pendingUserText: '' })),
      send: vi.fn(async () => undefined),
      cancel: vi.fn(async () => true),
      discardVoiceNote: vi.fn(async () => true),
      onDelta: () => () => {},
      onError: () => () => {},
      onTurnComplete: () => () => {},
      onPhase: () => () => {}
    }
  }
})

let latest: UseAssistantChat | null = null

function Pane({ id }: { id: string }): null {
  latest = useAssistantChat(id)
  return null
}

/** The two callers under comparison. `Unkeyed` is what AssistantView used to
 *  be: one surviving instance whose prop changes. */
function Unkeyed({ id }: { id: string }): React.JSX.Element {
  return React.createElement(Pane, { id })
}
function Keyed({ id }: { id: string }): React.JSX.Element {
  return React.createElement(Pane, { key: id, id })
}

async function mount(
  Caller: (p: { id: string }) => React.JSX.Element
): Promise<{ root: Root; render: (id: string) => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const render = async (id: string): Promise<void> => {
    await act(async () => {
      root.render(React.createElement(Caller, { id }))
    })
  }
  return { root, render }
}

describe('BUG-252 — the conversation pane is discarded on a switch', () => {
  it('UNKEYED: the previous conversation\'s scope survives the switch — the bug', async () => {
    const { root, render } = await mount(Unkeyed)
    await render('conv-a')
    expect(latest?.scope?.contactName, 'A must load first, or the test proves nothing').toBe(
      'Client A'
    )
    expect(latest?.learningExcluded).toBe(true)

    await render('conv-b') // B's record is still in flight

    expect(
      latest?.scope?.contactName,
      'this is the defect: B is on screen wearing A\'s scope chip'
    ).toBe('Client A')
    expect(latest?.learningExcluded, 'and A\'s learning setting').toBe(true)
    await act(async () => root.unmount())
  })

  it('KEYED: the switch clears scope and learning before B has loaded', async () => {
    const { root, render } = await mount(Keyed)
    await render('conv-a')
    expect(latest?.scope?.contactName).toBe('Client A')
    expect(latest?.learningExcluded).toBe(true)

    await render('conv-b') // B's record is still in flight

    expect(latest?.scope, 'a fresh instance cannot be wearing A\'s scope').toBeNull()
    expect(latest?.learningExcluded).toBe(false)

    // And B still loads correctly once its record arrives — the key must not
    // have broken the normal path.
    await act(async () => {
      releaseGet?.()
    })
    expect(latest?.scope).toBeNull()
    await act(async () => root.unmount())
  })

  it('AssistantView passes that key — the wiring, not just the mechanism', () => {
    // Comments are stripped first. A previous test in this repo matched a
    // string in a comment 40,000 characters from the code it claimed to pin,
    // and passed by luck; stripping is now a precondition, not a nicety.
    const src = readFileSync(join(__dirname, '..', 'AssistantView.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')

    const tag = src.indexOf('<AssistantConversation')
    expect(tag, 'AssistantView must render the extracted pane').toBeGreaterThan(-1)

    // The key must be on the element itself, so look only inside this tag.
    const openTag = src.slice(tag, src.indexOf('/>', tag))
    expect(openTag, 'the pane must be keyed on the conversation id').toMatch(
      /key=\{activeId\s*\?\?/
    )

    // The hook must have exactly one call site, or "it is keyed" is a claim
    // about one of several callers.
    const callers = readFileSync(join(__dirname, '..', 'AssistantView.tsx'), 'utf8').match(
      /useAssistantChat\(/g
    )
    expect(callers?.length, 'more than one call site means this pin covers only one').toBe(1)
  })
})
