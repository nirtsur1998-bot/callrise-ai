// @vitest-environment happy-dom
//
// BUG-246, RENDERED — the sentence the founder approved on 2026-09-09, and the
// branch it belongs to.
//
// WHY A TEST AND NOT A SCREENSHOT, the same reason the diagnostics empty-log
// card is tested this way: the Backup card lives behind the auth gate, and the
// provisioned sandbox deliberately carries no session — copying
// `supabase-auth.json` into a profile copy is BUG-186, and signing in would
// mean entering credentials, which is not something to automate. So the branch
// is unreachable on screen there, and forcing it would be a one-off proof that
// preserves nothing. This asserts the same thing permanently, in both
// directions.
//
// The IPC half IS driven, in the real app, and is not what this file covers:
// with the queue file replaced by a directory, `forgetEverything()` returned
// ok, `backup:getStatus` reported `pendingScrubs: ["salesBrain"]` (so the
// BUG-206 restore guard is armed) and `scrubQueuePersistError: {code:"EPERM"}`
// — the exact error BUG-244 measured on this machine.
//
// What is asserted here is the sentence, because it is approved privacy copy
// and a future edit should go red rather than quietly reword it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
// platform.ts reads `window.api.platform` at MODULE LOAD, before any beforeEach
// can install a stub - imports are hoisted. Mocked rather than worked around,
// because the alternative (a global assigned in a hoisted block) hides the
// dependency from the next reader.
vi.mock('@renderer/lib/platform', () => ({ isMac: false, isWindows: true }))

import { BackupCard } from '../BackupCard'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type StatusOverrides = Record<string, unknown>

function installApi(status: StatusOverrides): void {
  ;(window as unknown as Record<string, unknown>).api = {
    backup: {
      getStatus: vi.fn(async () => ({
        lastSyncAt: '2026-09-09T10:00:00.000Z',
        lastPushAt: '2026-09-09T10:00:00.000Z',
        pendingScrubs: [],
        signedIn: true,
        conflictCount: 0,
        ...status
      })),
      syncNow: vi.fn(async () => ({ ok: true })),
      pushNow: vi.fn(async () => ({ ok: true })),
      revealConflicts: vi.fn(async () => ({ ok: true })),
      onChanged: vi.fn(() => () => {})
    },
    settings: {
      get: vi.fn(async () => ({ syncScope: {} })),
      update: vi.fn(async () => ({ syncScope: {} }))
    },
    // useSingletonJob adopts an already-running sync on mount, so the card
    // reaches the job system before it reaches anything about scrubs.
    jobs: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      onChanged: vi.fn(() => () => {}),
      subscribe: vi.fn(() => () => {}),
      cancel: vi.fn(async () => true)
    },
    platform: 'win32'
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})
afterEach(() => {
  act(() => root?.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function render(): Promise<string> {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(BackupCard))
  })
  await act(async () => {
    await Promise.resolve()
  })
  return container.textContent ?? ''
}

describe('BUG-246 — an erase that could not be written down says so', () => {
  it('renders the approved sentence, word for word', async () => {
    installApi({
      pendingScrubs: ['salesBrain'],
      scrubQueuePersistError: { code: 'EPERM', at: '2026-09-09T16:34:38.868Z' }
    })
    const text = await render()
    // Approved by the founder 2026-09-09, with one change from the draft:
    // "will be lost" -> "won't survive a restart", because nothing that
    // existed is lost — it is the REQUEST that fails to persist. Do not
    // reword without asking again.
    expect(text).toContain(
      "Couldn't save your request to remove sales brain memories — it will run now, but won't survive a restart"
    )
  })

  it('outranks the two messages about a removal that WAS recorded', async () => {
    // "we could not write your request down" is a different and worse thing
    // than "we wrote it down and it is retrying". Both conditions true at
    // once, and the unrecorded one has to win.
    installApi({
      pendingScrubs: ['salesBrain'],
      signedIn: false,
      lastScrubErrorAt: '2026-09-09T11:00:00.000Z',
      scrubQueuePersistError: { code: 'EPERM', at: '2026-09-09T16:34:38.868Z' }
    })
    const text = await render()
    expect(text).toContain("Couldn't save your request to remove")
    expect(text).not.toContain('Sign in to finish removing')
    expect(text).not.toContain('Still removing')
  })

  it('outranks a SYNC ERROR too, which driving the card is what found', async () => {
    // The card's message is one ternary chain, and errorMessage sat above the
    // scrub branch. In the sandbox that meant the dev-refusal line occupied
    // the slot and this warning could never render; in production an ordinary
    // "the last backup didn't finish, it will retry" would have done the same.
    //
    // A push error says "your work isn't saved YET" and resolves itself. An
    // unrecorded erase does not resolve itself and only the user can act on
    // it. Reading the code did not surface this; opening the page did.
    installApi({
      pendingScrubs: ['salesBrain'],
      lastPushError: 'sandbox',
      lastPushErrorAt: '2026-09-09T16:00:00.000Z',
      scrubQueuePersistError: { code: 'EPERM', at: '2026-09-09T16:34:38.868Z' }
    })
    const text = await render()
    expect(text).toContain("Couldn't save your request to remove")
    expect(text).not.toContain('dev sandbox copy')
  })

  it('says nothing of the sort when the request was recorded normally', async () => {
    // The control. Without it, a card that always showed the warning would
    // pass the two tests above.
    installApi({ pendingScrubs: [], scrubQueuePersistError: null })
    const text = await render()
    expect(text).not.toContain("Couldn't save your request")
    expect(text).toContain('Backed up')
  })
})
