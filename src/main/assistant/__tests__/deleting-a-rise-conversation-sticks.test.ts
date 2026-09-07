// BUG-207 — deleting a Rise conversation must actually delete it.
//
// It did not. `deleteConversation` unlinked the local file, which is a deletion
// on this disk and nowhere else. With `riseConversations` sync ON, which is the
// DEFAULT, the cloud row survived carrying `deleted: false` (hardcoded in the
// push), `reconcileStore` found no local counterpart and no tombstone, and
// re-imported the thread on the next restore — on the SAME machine, minutes
// later, under a dialog that said "This cannot be undone."
//
// The store's own doc comment described this outcome while the dialog denied
// it, which is taxonomy species 84: the comment is the design, the constant is
// the product.
//
// The fix is the tombstone every other collection in this app already has.
// These tests drive the real filesystem functions in a temp directory.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  importConversation,
  sanitizeConversation
} from '../conversations-fs'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rise-tombstone-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function seed(title: string): Promise<string> {
  const conv = await createConversation(dir, title)
  expect(conv, 'could not create a conversation to delete').toBeTruthy()
  return conv.id
}

describe('deleting a Rise conversation leaves a tombstone', () => {
  it('THE BUG: the record must survive as a tombstone, not vanish from disk', async () => {
    // Vanishing is the bug. A file that is simply gone cannot tell the cloud
    // anything, so the cloud keeps saying the thread exists.
    const id = await seed('Pricing objections')
    expect(await deleteConversation(dir, id)).toBe(true)

    const path = join(dir, `${id}.json`)
    expect(existsSync(path), 'the record was unlinked — the deletion cannot travel').toBe(true)

    const raw = JSON.parse(readFileSync(path, 'utf8'))
    expect(raw.deleted, 'the tombstone must carry the flag that travels').toBe(true)
  })

  it('the tombstone keeps no words and no title', async () => {
    const id = await seed('Pricing objections')
    await deleteConversation(dir, id)
    const raw = readFileSync(join(dir, `${id}.json`), 'utf8')
    expect(raw).not.toContain('Pricing objections')
    const parsed = JSON.parse(raw)
    expect(parsed.messages).toEqual([])
    expect(parsed.title).toBe('')
  })

  it('the deleted thread is gone from the list, and gone from a direct read', async () => {
    const id = await seed('Pricing objections')
    const other = await seed('Renewal call')
    await deleteConversation(dir, id)

    const visible = await listConversations(dir)
    expect(visible.map((c) => c.id)).toEqual([other])
    expect(await getConversation(dir, id), 'a deleted thread must not open').toBeNull()
  })

  it('but the BACKUP can still see it — that is the whole point', async () => {
    const id = await seed('Pricing objections')
    await deleteConversation(dir, id)

    const forBackup = await listConversations(dir, { includeDeleted: true })
    expect(forBackup.map((c) => c.id)).toContain(id)
    const full = await getConversation(dir, id, { includeDeleted: true })
    expect(full?.deleted).toBe(true)
  })

  it('THE RESURRECTION: an older cloud copy cannot bring the thread back', async () => {
    // This is the exact sequence that made the dialog a lie. The cloud row
    // predates the deletion, so the tombstone is newer and wins.
    const id = await seed('Pricing objections')
    const before = await getConversation(dir, id)
    await deleteConversation(dir, id)

    const resurrected = await importConversation(dir, before, { onlyIfNewer: true })
    expect(resurrected, 'the stale cloud copy overwrote the tombstone').toBeNull()
    expect(await getConversation(dir, id)).toBeNull()
    expect(readFileSync(join(dir, `${id}.json`), 'utf8')).not.toContain('Pricing objections')
  })

  it('a payload claiming to be deleted cannot smuggle message text back onto disk', async () => {
    // The sanitiser drops the words for ANY deleted record, whatever the
    // payload says, so a hand-edited file or a row from an older build cannot
    // reintroduce content under a tombstone.
    const sanitised = sanitizeConversation({
      id: '11111111-2222-4333-8444-555555555555',
      title: 'should not survive',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deleted: true,
      messages: [{ id: 'm1', role: 'user', content: 'the buyer said something private' }]
    })
    expect(sanitised?.deleted).toBe(true)
    expect(sanitised?.messages).toEqual([])
    expect(sanitised?.title).toBe('')
  })

  it('deleting twice is idempotent and does not resurrect anything', async () => {
    const id = await seed('Pricing objections')
    expect(await deleteConversation(dir, id)).toBe(true)
    expect(await deleteConversation(dir, id)).toBe(true)
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(1)
    expect(await getConversation(dir, id)).toBeNull()
  })

  it('deleting something that was never there returns false', async () => {
    expect(await deleteConversation(dir, '99999999-8888-4777-8666-555555555555')).toBe(false)
  })
})
