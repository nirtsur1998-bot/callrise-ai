// M39 Stage 2 — the deferred half of the live identity offer.
//
// This is the part that can fail invisibly. Mid-call there is no Call record,
// so the chip's button cannot write anything; the decision is held and applied
// when the call saves. If that application silently did nothing, the chip
// would still say "Linked to Kerry when this call saves" and the rep would
// find out an hour later, or never — `calls:setContact` returns null when the
// call does not exist, which from the renderer is indistinguishable from
// success.
//
// So every case here asserts the WRITE, by argument, not the absence of an
// error.
import { describe, expect, it, vi } from 'vitest'
import { applyIdentityDecision, type IdentityWriteApi } from '../useLiveIdentityOffer'

const CONTACTS = [
  { id: 'kerry', name: 'kerry' },
  { id: 'harvey', name: 'Harvey' }
]

function fakeApi(overrides?: Partial<IdentityWriteApi>): IdentityWriteApi & {
  setContact: ReturnType<typeof vi.fn>
  createContact: ReturnType<typeof vi.fn>
} {
  return {
    setContact: vi.fn(async () => ({})),
    createContact: vi.fn(async ({ name }: { name: string }) => ({ id: `new-${name}` })),
    ...overrides
  } as IdentityWriteApi & {
    setContact: ReturnType<typeof vi.fn>
    createContact: ReturnType<typeof vi.fn>
  }
}

describe('M39 — applying a live identity decision to the saved call', () => {
  it('links the chosen contact to the call that was just saved', async () => {
    const api = fakeApi()
    const linked = await applyIdentityDecision(
      { kind: 'link', contactId: 'harvey', contactName: 'Harvey' },
      'saved-call-1',
      CONTACTS,
      api
    )
    expect(api.setContact).toHaveBeenCalledWith('saved-call-1', 'harvey')
    expect(linked).toBe('harvey')
    expect(api.createContact).not.toHaveBeenCalled()
  })

  it('creates a contact, then links THAT contact', async () => {
    const api = fakeApi()
    const linked = await applyIdentityDecision(
      { kind: 'create', name: 'Anshur Bell' },
      'saved-call-2',
      CONTACTS,
      api
    )
    expect(api.createContact).toHaveBeenCalledWith({ name: 'Anshur Bell' })
    expect(api.setContact).toHaveBeenCalledWith('saved-call-2', 'new-Anshur Bell')
    expect(linked).toBe('new-Anshur Bell')
  })

  it('links an existing same-name contact rather than minting a duplicate', async () => {
    // A name-only signal has no email to dedupe by. Without this, the same
    // buyer heard on two calls becomes two contact records with no way to
    // merge them — which is worse than the missing link it was fixing.
    const api = fakeApi()
    const linked = await applyIdentityDecision(
      { kind: 'create', name: '  harvey  ' },
      'saved-call-3',
      CONTACTS,
      api
    )
    expect(api.createContact).not.toHaveBeenCalled()
    expect(api.setContact).toHaveBeenCalledWith('saved-call-3', 'harvey')
    expect(linked).toBe('harvey')
  })

  it('writes NOTHING when the rep never answered', async () => {
    const api = fakeApi()
    expect(await applyIdentityDecision(null, 'saved-call-4', CONTACTS, api)).toBeNull()
    expect(api.setContact).not.toHaveBeenCalled()
    expect(api.createContact).not.toHaveBeenCalled()
  })

  it('writes NOTHING when there is no call id', async () => {
    // The state this whole design exists for. An empty id is what the renderer
    // holds mid-call, and calls:setContact would accept it and return null —
    // a no-op that reads as success.
    const api = fakeApi()
    expect(
      await applyIdentityDecision(
        { kind: 'link', contactId: 'harvey', contactName: 'Harvey' },
        '',
        CONTACTS,
        api
      )
    ).toBeNull()
    expect(api.setContact).not.toHaveBeenCalled()
  })

  it('a failed create never links anything and never throws', async () => {
    const api = fakeApi({ createContact: vi.fn(async () => null) })
    expect(
      await applyIdentityDecision({ kind: 'create', name: 'Nobody' }, 'call-5', CONTACTS, api)
    ).toBeNull()
    expect(api.setContact).not.toHaveBeenCalled()
  })

  it('a thrown IPC is swallowed — the save must not care', async () => {
    const api = fakeApi({
      setContact: vi.fn(async () => {
        throw new Error('ipc gone')
      })
    })
    await expect(
      applyIdentityDecision(
        { kind: 'link', contactId: 'harvey', contactName: 'Harvey' },
        'call-6',
        CONTACTS,
        api
      )
    ).resolves.toBeNull()
  })
})
