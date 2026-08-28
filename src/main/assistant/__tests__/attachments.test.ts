// M28 Part 3 — attachments: classification by extension, size caps in words,
// local text extraction, and the trusted stored record handleSend reads back.
// Real temp-dir files throughout.
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addAttachment,
  classifyAttachment,
  deleteAttachment,
  readAttachmentBytes,
  readAttachmentRecord,
  ATTACHMENT_LIMITS,
  MAX_EXTRACTED_CHARS
} from '../attachments'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'attachments-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('classifyAttachment', () => {
  it('classifies by extension only, case-insensitively', () => {
    expect(classifyAttachment('photo.PNG')).toMatchObject({ kind: 'image', mimeType: 'image/png' })
    expect(classifyAttachment('deck.pdf')).toMatchObject({ kind: 'pdf' })
    expect(classifyAttachment('notes.docx')).toMatchObject({ kind: 'text' })
    expect(classifyAttachment('data.csv')).toMatchObject({ kind: 'text', mimeType: 'text/csv' })
    expect(classifyAttachment('virus.exe')).toBeNull()
    expect(classifyAttachment('noext')).toBeNull()
  })
})

describe('addAttachment', () => {
  it('a text file is extracted, stored as what-will-be-sent, and previewed', async () => {
    const result = await addAttachment(dir, 'brief.txt', Buffer.from('Acme wants a pilot first.\nBudget 40k.'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attachment.kind).toBe('text')
    expect(result.attachment.extractedChars).toBe('Acme wants a pilot first.\nBudget 40k.'.length)
    expect(result.preview).toContain('Acme wants a pilot first.')
    // The trusted record + the stored text round-trip.
    const record = await readAttachmentRecord(dir, result.attachment.id)
    expect(record?.storedExt).toBe('txt')
    const bytes = await readAttachmentBytes(dir, record!)
    expect(bytes?.toString('utf8')).toBe('Acme wants a pilot first.\nBudget 40k.')
  })

  it('extracted text is capped at MAX_EXTRACTED_CHARS and the count says so', async () => {
    const big = 'x'.repeat(MAX_EXTRACTED_CHARS + 500)
    const result = await addAttachment(dir, 'big.md', Buffer.from(big))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attachment.extractedChars).toBe(MAX_EXTRACTED_CHARS)
  })

  it('images and PDFs are stored as bytes with honest previews', async () => {
    const img = await addAttachment(dir, 'shot.png', Buffer.from([137, 80, 78, 71, 1, 2, 3]))
    expect(img.ok && img.attachment.kind).toBe('image')
    expect(img.ok && img.preview).toContain('vision')
    const pdf = await addAttachment(dir, 'proposal.pdf', Buffer.from('%PDF-1.4 fake'))
    expect(pdf.ok && pdf.attachment.kind).toBe('pdf')
    expect(pdf.ok && pdf.preview).toContain('PDF')
  })

  it('size caps are refused in plain words before anything is stored', async () => {
    const tooBig = Buffer.alloc(ATTACHMENT_LIMITS.image + 1)
    const result = await addAttachment(dir, 'huge.png', tooBig)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('limit for images')
    expect((await readdir(dir).catch(() => [])).length).toBe(0) // nothing written
  })

  it('unsupported types and binary-garbage "text" are refused, never stored', async () => {
    expect((await addAttachment(dir, 'tool.exe', Buffer.from('MZ'))).ok).toBe(false)
    // Nothing at all on disk yet — the .exe was rejected by extension alone,
    // before the attachments dir is ever created.
    expect(await readdir(dir).catch(() => [])).toEqual([])

    const garbage = Buffer.from(Array.from({ length: 400 }, (_, i) => i % 7)) // control chars
    const result = await addAttachment(dir, 'weird.txt', garbage)
    expect(result.ok).toBe(false)
    // The attachments dir may now exist (mkdir runs before extraction is
    // checked), but it must hold no file — no bytes, no orphaned record.
    expect(await readdir(join(dir, 'attachments')).catch(() => [])).toEqual([])
  })

  it('delete removes both the bytes and the record; traversal ids are ignored', async () => {
    const result = await addAttachment(dir, 'a.txt', Buffer.from('hello'))
    if (!result.ok) throw new Error('setup')
    await deleteAttachment(dir, result.attachment.id)
    expect(await readAttachmentRecord(dir, result.attachment.id)).toBeNull()
    expect(await readdir(join(dir, 'attachments'))).toEqual([])
    await deleteAttachment(dir, '../../evil') // must not throw or escape
  })
})
