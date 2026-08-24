// M28 — the Rise conversation store. Every assertion reads back through the
// real files in a real temp dir (no in-memory doubles): what these tests
// prove is persistence, not object bookkeeping.
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendTurn,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  markSuggestionApplied,
  renameConversation,
  MAX_MESSAGES,
  MAX_TITLE_CHARS
} from '../conversations-fs'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'assistant-conv-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('create / list / rename / delete', () => {
  it('a created conversation is listed; list is empty-dir safe', async () => {
    expect(await listConversations(dir)).toEqual([])
    const conv = await createConversation(dir)
    const metas = await listConversations(dir)
    expect(metas).toHaveLength(1)
    expect(metas[0].id).toBe(conv.id)
    expect(metas[0].title).toBe('New conversation')
    expect(metas[0].messageCount).toBe(0)
  })

  it('list sorts by updatedAt desc and carries a preview of the latest message', async () => {
    const a = await createConversation(dir, 'Older')
    const b = await createConversation(dir, 'Newer')
    // Deterministic ordering without sleeping: stamp updatedAt via a turn on b.
    await appendTurn(dir, b.id, { text: 'What stalled the Acme deal?\nsecond line' }, { text: 'reply' })
    const metas = await listConversations(dir)
    expect(metas.map((m) => m.id)).toEqual([b.id, a.id])
    // Preview is the latest message's FIRST line only.
    expect(metas[0].preview).toBe('reply')
  })

  it('rename persists and rejects empty titles', async () => {
    const conv = await createConversation(dir)
    expect(await renameConversation(dir, conv.id, '   ')).toBeNull()
    await renameConversation(dir, conv.id, 'Q3 pipeline review')
    const back = await getConversation(dir, conv.id)
    expect(back?.title).toBe('Q3 pipeline review')
  })

  it('delete removes the file; deleting a missing id reports false', async () => {
    const conv = await createConversation(dir)
    expect(await deleteConversation(dir, conv.id)).toBe(true)
    expect(await getConversation(dir, conv.id)).toBeNull()
    expect(await deleteConversation(dir, conv.id)).toBe(false)
    // No stray temp files left behind by the atomic writer either.
    expect((await readdir(dir)).filter((n) => n.endsWith('.json'))).toEqual([])
  })
})

describe('appendTurn', () => {
  // AUDIT FIX (2026-08-25) — appendTurn's RETURNED IDS are the contract that
  // replaced positional inference (BUG-110). Tested here rather than at the
  // IPC layer, and the distinction is the point: at the IPC layer, with a
  // real store, "the id I was handed" and "messages[length - 2].id" are
  // INDISTINGUISHABLE by behaviour, because the array is always well-formed.
  // Reverting the caller to positional there passes 3/3 — I checked. The
  // mechanism only becomes assertable where the ids are minted.
  //
  // Resolved by LOOKUP, never by index: indexing is the thing under test, so
  // a test that indexes proves the array's shape rather than the contract.
  it('returns the ids it minted, and they resolve to the right roles and texts', async () => {
    const conv = await createConversation(dir)
    const first = await appendTurn(dir, conv.id, { text: 'first ask' }, { text: 'first reply' })
    const second = await appendTurn(dir, conv.id, { text: 'second ask' }, { text: 'second reply' })
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()

    const stored = await getConversation(dir, conv.id)
    const byId = (id: string) => stored?.messages.find((m) => m.id === id)

    const u = byId(second!.userMessageId)
    const a = byId(second!.assistantMessageId)
    expect(u, 'the returned userMessageId matches no persisted message').toBeTruthy()
    expect(a, 'the returned assistantMessageId matches no persisted message').toBeTruthy()
    expect(u?.role).toBe('user')
    expect(u?.text).toBe('second ask')
    expect(a?.role).toBe('assistant')
    expect(a?.text).toBe('second reply')

    // Each turn's ids are its own — a stale or reused id would still resolve
    // to SOME message, so identity across turns has to be asserted too.
    expect(second!.userMessageId).not.toBe(first!.userMessageId)
    expect(byId(first!.userMessageId)?.text).toBe('first ask')
  })

  it('persists one complete turn and auto-titles from the first user message', async () => {
    const conv = await createConversation(dir)
    await appendTurn(dir, conv.id, { text: 'Prep me for the 2pm with Dana' }, { text: 'Sure —' })
    const back = await getConversation(dir, conv.id)
    expect(back?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(back?.title).toBe('Prep me for the 2pm with Dana')
    // A second turn must NOT retitle.
    await appendTurn(dir, conv.id, { text: 'And the 3pm?' }, { text: 'Also —' })
    expect((await getConversation(dir, conv.id))?.title).toBe('Prep me for the 2pm with Dana')
  })

  it('a user-renamed conversation is never auto-retitled', async () => {
    const conv = await createConversation(dir, 'My planning thread')
    await appendTurn(dir, conv.id, { text: 'hello' }, { text: 'hi' })
    expect((await getConversation(dir, conv.id))?.title).toBe('My planning thread')
  })

  it('caps the thread at MAX_MESSAGES, dropping oldest first', async () => {
    const conv = await createConversation(dir)
    const seeded = {
      ...conv,
      messages: Array.from({ length: MAX_MESSAGES }, (_, i) => ({
        id: `m-${i}`,
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        text: `msg ${i}`,
        createdAt: new Date().toISOString()
      }))
    }
    await writeFile(join(dir, `${conv.id}.json`), JSON.stringify(seeded))
    await appendTurn(dir, conv.id, { text: 'newest user' }, { text: 'newest assistant' })
    const back = await getConversation(dir, conv.id)
    expect(back?.messages).toHaveLength(MAX_MESSAGES)
    expect(back?.messages[MAX_MESSAGES - 1].text).toBe('newest assistant')
    expect(back?.messages[0].text).toBe('msg 2') // the two oldest fell off
  })

  it('persists citations on the assistant message and suggestions on the user message', async () => {
    const conv = await createConversation(dir)
    await appendTurn(
      dir,
      conv.id,
      {
        text: 'We use HubSpot',
        suggestions: [
          { id: 'sug-1', type: 'memory', text: 'Uses HubSpot', confidence: 'high', memoryScope: 'business', memoryCategory: 'terminology' }
        ]
      },
      {
        text: 'Noted [1]',
        citations: [{ kind: 'memory', id: 'mem-1', label: 'Uses HubSpot' }]
      }
    )
    const back = await getConversation(dir, conv.id)
    expect(back?.messages[0].suggestions?.[0].id).toBe('sug-1')
    expect(back?.messages[1].citations?.[0]).toEqual({ kind: 'memory', id: 'mem-1', label: 'Uses HubSpot' })
  })

  it('serializes concurrent appends to the same conversation (no lost turns)', async () => {
    const conv = await createConversation(dir)
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        appendTurn(dir, conv.id, { text: `u${i}` }, { text: `a${i}` })
      )
    )
    const back = await getConversation(dir, conv.id)
    expect(back?.messages).toHaveLength(10) // 5 turns × 2 — a clobber would lose some
  })
})

describe('M28 Part 4 — scope is an identity fixed at creation', () => {
  it('a scoped conversation persists its scope, default-titles "About X", and surfaces scope in the list', async () => {
    const conv = await createConversation(dir, undefined, {
      contactId: 'acme-1',
      contactName: 'Dana Levy',
      company: 'Acme'
    })
    expect(conv.title).toBe('About Dana Levy')
    const back = await getConversation(dir, conv.id)
    expect(back?.scope).toEqual({ contactId: 'acme-1', contactName: 'Dana Levy', company: 'Acme' })
    expect((await listConversations(dir))[0].scope?.contactId).toBe('acme-1')
    // First message still auto-titles over the scoped default.
    await appendTurn(dir, conv.id, { text: 'Where do we stand?' }, { text: 'Close.' })
    expect((await getConversation(dir, conv.id))?.title).toBe('Where do we stand?')
  })

  it('a malformed scope is dropped, never half-stored', async () => {
    const conv = await createConversation(dir, undefined, {
      contactId: 'has spaces!',
      contactName: 'x'
    })
    expect(conv.scope).toBeUndefined()
    expect(conv.title).toBe('New conversation')
  })
})

describe('M28 Part 3 — attachment metadata on user messages', () => {
  it('persists and sanitizes attachments (unknown kinds dropped)', async () => {
    const conv = await createConversation(dir)
    await appendTurn(
      dir,
      conv.id,
      {
        text: 'see attached',
        attachments: [
          { id: 'att-1', name: 'brief.txt', kind: 'text', mimeType: 'text/plain', sizeBytes: 120, extractedChars: 118 },
          { id: 'att-2', name: 'x', kind: 'zip' as 'text', mimeType: 'application/zip', sizeBytes: 1 }
        ]
      },
      { text: 'ok' }
    )
    const back = await getConversation(dir, conv.id)
    expect(back?.messages[0].attachments).toEqual([
      { id: 'att-1', name: 'brief.txt', kind: 'text', mimeType: 'text/plain', sizeBytes: 120, extractedChars: 118 }
    ])
  })
})

describe('markSuggestionApplied', () => {
  it('applied ids survive a fresh read from disk and never duplicate', async () => {
    const conv = await createConversation(dir)
    await appendTurn(
      dir,
      conv.id,
      { text: 'hi', suggestions: [{ id: 'sug-1', type: 'call-notes', text: 'x', confidence: 'medium' }] },
      { text: 'reply' }
    )
    const userMsg = (await getConversation(dir, conv.id))!.messages[0]
    await markSuggestionApplied(dir, conv.id, userMsg.id, 'sug-1')
    await markSuggestionApplied(dir, conv.id, userMsg.id, 'sug-1')
    const back = await getConversation(dir, conv.id)
    expect(back?.messages[0].appliedSuggestionIds).toEqual(['sug-1'])
  })
})

describe('sanitize-on-read', () => {
  it('a corrupt file is skipped by list and reads as null, never a throw', async () => {
    await writeFile(join(dir, 'broken.json'), '{ not json')
    const good = await createConversation(dir, 'Fine')
    const metas = await listConversations(dir)
    expect(metas.map((m) => m.id)).toEqual([good.id])
    expect(await getConversation(dir, 'broken')).toBeNull()
  })

  it('oversized titles and unknown message roles are clamped/dropped on read', async () => {
    const id = 'aaaaaaaa-1111-2222-3333-444444444444'
    await writeFile(
      join(dir, `${id}.json`),
      JSON.stringify({
        id,
        title: 'x'.repeat(500),
        messages: [
          { id: 'ok-1', role: 'user', text: 'kept', createdAt: 'now' },
          { id: 'bad', role: 'system', text: 'dropped' },
          { id: 'bad2', role: 'assistant', text: '' }
        ]
      })
    )
    const back = await getConversation(dir, id)
    expect(back?.title).toHaveLength(MAX_TITLE_CHARS)
    expect(back?.messages.map((m) => m.text)).toEqual(['kept'])
  })
})
