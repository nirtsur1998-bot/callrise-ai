import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface CallSegment {
  speaker: number
  text: string
}

export interface CallSummary {
  id: string
  title: string
  createdAt: string // ISO timestamp
  durationMs: number
  speakerCount: number
  preview: string
}

export interface Call extends CallSummary {
  segments: CallSegment[]
}

export interface CallSaveInput {
  startedAt: string
  durationMs: number
  segments: CallSegment[]
}

// Ids are used to build file paths, so they must be tightly constrained
// (no "../", no slashes) to prevent path traversal.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/
const MAX_SEGMENTS = 5000
const MAX_TEXT = 20000

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

function formatTitle(date: Date): string {
  const when = date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
  return `Call · ${when}`
}

function sanitizeSegments(value: unknown): CallSegment[] {
  if (!Array.isArray(value)) return []
  const out: CallSegment[] = []
  for (const item of value.slice(0, MAX_SEGMENTS)) {
    if (!item || typeof item !== 'object') continue
    const speakerRaw = (item as { speaker?: unknown }).speaker
    const textRaw = (item as { text?: unknown }).text
    const speaker = Number.isFinite(speakerRaw) ? Math.max(0, Math.trunc(speakerRaw as number)) : 0
    const text = typeof textRaw === 'string' ? textRaw.slice(0, MAX_TEXT) : ''
    if (text.trim()) out.push({ speaker, text })
  }
  return out
}

function toSummary(call: Call): CallSummary {
  return {
    id: call.id,
    title: call.title,
    createdAt: call.createdAt,
    durationMs: call.durationMs,
    speakerCount: call.speakerCount,
    preview: call.preview
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export async function saveCall(dir: string, input: CallSaveInput): Promise<CallSummary> {
  await ensureDir(dir)
  const segments = sanitizeSegments(input?.segments)
  const startedAt = typeof input?.startedAt === 'string' ? input.startedAt : ''
  const createdDate =
    startedAt && !Number.isNaN(Date.parse(startedAt)) ? new Date(startedAt) : new Date()
  const durationMs =
    Number.isFinite(input?.durationMs) ? Math.max(0, Math.trunc(input.durationMs)) : 0
  const id = randomUUID()
  const transcriptText = segments.map((s) => s.text).join(' ')
  const call: Call = {
    id,
    title: formatTitle(createdDate),
    createdAt: createdDate.toISOString(),
    durationMs,
    speakerCount: new Set(segments.map((s) => s.speaker)).size,
    preview: transcriptText.slice(0, 160),
    segments
  }
  await fs.writeFile(join(dir, `${id}.json`), JSON.stringify(call, null, 2), 'utf8')
  return toSummary(call)
}

export async function listCalls(dir: string): Promise<CallSummary[]> {
  await ensureDir(dir)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const summaries: CallSummary[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(join(dir, file), 'utf8')
      const call = JSON.parse(raw) as Call
      if (call && typeof call.id === 'string') summaries.push(toSummary(call))
    } catch {
      /* skip unreadable / corrupt file */
    }
  }
  // Newest first.
  summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return summaries
}

export async function getCall(dir: string, id: string): Promise<Call | null> {
  if (!isSafeId(id)) return null
  try {
    const raw = await fs.readFile(join(dir, `${id}.json`), 'utf8')
    return JSON.parse(raw) as Call
  } catch {
    return null
  }
}

export async function deleteCall(dir: string, id: string): Promise<{ ok: boolean }> {
  if (!isSafeId(id)) return { ok: false }
  try {
    await fs.unlink(join(dir, `${id}.json`))
    return { ok: true }
  } catch {
    return { ok: false }
  }
}
