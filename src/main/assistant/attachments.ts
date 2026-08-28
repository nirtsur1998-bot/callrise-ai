// M28 Part 3 — files attached to Rise messages. Everything stays LOCAL: the
// bytes land in the conversations media dir, text is extracted on this
// machine, and a file only ever reaches the user's own provider on send —
// images as native vision parts, a PDF as the existing `document` input,
// documents (docx/txt/md/csv) as locally-extracted text in the context.
// Size caps are checked BEFORE anything is stored and reported in words.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import mammoth from 'mammoth'
import type { AssistantAttachment } from './conversations-fs'

export type AttachmentKind = AssistantAttachment['kind']

export const ATTACHMENT_LIMITS: Record<AttachmentKind, number> = {
  image: 8 * 1024 * 1024,
  pdf: 15 * 1024 * 1024,
  text: 2 * 1024 * 1024
}
/** What the model actually receives for a text document — the preview shows
 *  exactly this, truncated exactly here. */
export const MAX_EXTRACTED_CHARS = 40_000

const IMAGE_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}
const TEXT_EXT = new Set(['txt', 'md', 'csv', 'docx'])

export interface ClassifiedFile {
  kind: AttachmentKind
  ext: string
  mimeType: string
}

/** Classify by EXTENSION (the only thing we can trust about a dropped file),
 *  never by the mime type the renderer claims. null = not an accepted type. */
export function classifyAttachment(name: string): ClassifiedFile | null {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  if (IMAGE_EXT[ext]) return { kind: 'image', ext, mimeType: IMAGE_EXT[ext] }
  if (ext === 'pdf') return { kind: 'pdf', ext, mimeType: 'application/pdf' }
  if (TEXT_EXT.has(ext)) {
    return {
      kind: 'text',
      ext,
      mimeType:
        ext === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : ext === 'csv'
            ? 'text/csv'
            : ext === 'md'
              ? 'text/markdown'
              : 'text/plain'
    }
  }
  return null
}

export function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** Cheap "is this really text" heuristic, ported from calls.ts's attachment
 *  path: a UTF-8 decode of a binary blob is mostly replacement characters. */
function looksLikeText(text: string): boolean {
  if (text.length === 0) return false
  const sample = text.slice(0, 4000)
  let bad = 0
  for (const ch of sample) {
    const code = ch.charCodeAt(0)
    if (code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13)) bad++
  }
  return bad / sample.length < 0.05
}

/** Extract the text a document will contribute. null = unreadable. */
export async function extractDocumentText(ext: string, bytes: Buffer): Promise<string | null> {
  if (ext === 'docx') {
    try {
      const result = await mammoth.extractRawText({ buffer: bytes })
      return (result.value ?? '').trim()
    } catch {
      return null
    }
  }
  const text = bytes.toString('utf8')
  return looksLikeText(text) ? text : null
}

export function attachmentsDir(conversationsDir: string): string {
  return join(conversationsDir, 'attachments')
}

const ID_RE = /^[A-Za-z0-9-]{1,64}$/

export interface StoredAttachmentRecord extends AssistantAttachment {
  /** Extension the bytes were stored under (`<id>.<ext>`), or 'txt' for the
   *  extracted text of a document — i.e. exactly what will be sent. */
  storedExt: string
  /**
   * AUDIT FIX (2026-08-24) — CROSS-CLIENT LEAK. The conversation this file was
   * staged for.
   *
   * Attachments had no owner. `pendingFiles` is component-level renderer state
   * that no setActiveId site cleared, and the stored record carried no
   * conversation id, so a file staged in client A's scoped conversation stayed
   * in the composer when the user clicked client B's conversation in the rail
   * — and was shipped verbatim into B's turn.
   *
   * The main process could not catch it, and that is the part worth fixing
   * here rather than only in the UI: readAttachmentRecord resolves any id
   * against one shared attachments/ directory and loadAttachments validated
   * only that the record EXISTED. There was no ownership to check. Clearing
   * the composer on conversation change fixes the one path anyone thought of;
   * recording the owner makes every other path fail closed too.
   */
  conversationId?: string
}

export type AddAttachmentResult =
  | { ok: true; attachment: AssistantAttachment; preview: string }
  | { ok: false; message: string }

/** Validate, cap, extract, and store. Writes `<id>.<ext>` (bytes, or the
 *  extracted text) plus `<id>.json` (the trusted metadata handleSend reads
 *  back — the renderer never supplies metadata at send time). */
export async function addAttachment(
  conversationsDir: string,
  name: string,
  bytes: Buffer,
  /** The conversation this file is being staged for — see
   *  StoredAttachmentRecord.conversationId. */
  conversationId?: string
): Promise<AddAttachmentResult> {
  const classified = classifyAttachment(name)
  if (!classified) {
    return {
      ok: false,
      message: `"${name}" isn't a supported type. You can attach images (PNG, JPG, WebP, GIF), PDFs, and documents (DOCX, TXT, MD, CSV).`
    }
  }
  const limit = ATTACHMENT_LIMITS[classified.kind]
  if (bytes.byteLength > limit) {
    return {
      ok: false,
      message: `"${name}" is ${humanSize(bytes.byteLength)} — the limit for ${classified.kind === 'image' ? 'images' : classified.kind === 'pdf' ? 'PDFs' : 'documents'} is ${humanSize(limit)}.`
    }
  }
  if (bytes.byteLength === 0) return { ok: false, message: `"${name}" is empty.` }

  const dir = attachmentsDir(conversationsDir)
  await fs.mkdir(dir, { recursive: true })
  const id = randomUUID()

  if (classified.kind === 'text') {
    const extracted = await extractDocumentText(classified.ext, bytes)
    if (extracted === null) {
      return {
        ok: false,
        message: `"${name}" couldn't be read as text — it may be corrupt or not really a ${classified.ext.toUpperCase()} file.`
      }
    }
    if (!extracted.trim()) return { ok: false, message: `"${name}" contains no readable text.` }
    const sent = extracted.slice(0, MAX_EXTRACTED_CHARS)
    const record: StoredAttachmentRecord = {
      id,
      name: name.slice(0, 200),
      kind: 'text',
      mimeType: classified.mimeType,
      sizeBytes: bytes.byteLength,
      extractedChars: sent.length,
      storedExt: 'txt',
      conversationId
    }
    await fs.writeFile(join(dir, `${id}.txt`), sent, 'utf8')
    await fs.writeFile(join(dir, `${id}.json`), JSON.stringify(record), 'utf8')
    const { storedExt: _ext, ...attachment } = record
    void _ext
    return { ok: true, attachment, preview: sent.slice(0, 600) }
  }

  const record: StoredAttachmentRecord = {
    id,
    name: name.slice(0, 200),
    kind: classified.kind,
    mimeType: classified.mimeType,
    sizeBytes: bytes.byteLength,
    storedExt: classified.ext,
    conversationId
  }
  await fs.writeFile(join(dir, `${id}.${classified.ext}`), bytes)
  await fs.writeFile(join(dir, `${id}.json`), JSON.stringify(record), 'utf8')
  const { storedExt: _ext2, ...attachment } = record
  void _ext2
  return {
    ok: true,
    attachment,
    preview:
      classified.kind === 'image'
        ? 'Sent as an image to your AI provider (needs a vision-capable model).'
        : 'Sent as a PDF to your AI provider.'
  }
}

export async function readAttachmentRecord(
  conversationsDir: string,
  id: string
): Promise<StoredAttachmentRecord | null> {
  if (!ID_RE.test(id)) return null
  try {
    const raw = await fs.readFile(join(attachmentsDir(conversationsDir), `${id}.json`), 'utf8')
    const rec = JSON.parse(raw) as StoredAttachmentRecord
    return rec && rec.id === id && /^[a-z0-9]{1,8}$/.test(rec.storedExt) ? rec : null
  } catch {
    return null
  }
}

export async function readAttachmentBytes(
  conversationsDir: string,
  record: StoredAttachmentRecord
): Promise<Buffer | null> {
  if (!ID_RE.test(record.id)) return null
  try {
    return await fs.readFile(join(attachmentsDir(conversationsDir), `${record.id}.${record.storedExt}`))
  } catch {
    return null
  }
}

export async function deleteAttachment(conversationsDir: string, id: string): Promise<void> {
  if (!ID_RE.test(id)) return
  const record = await readAttachmentRecord(conversationsDir, id)
  const dir = attachmentsDir(conversationsDir)
  if (record) await fs.unlink(join(dir, `${record.id}.${record.storedExt}`)).catch(() => {})
  await fs.unlink(join(dir, `${id}.json`)).catch(() => {})
}
