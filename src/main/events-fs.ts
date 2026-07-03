import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * A calendar event stored on disk (one JSON file per event). Times are
 * absolute ISO instants so they're unambiguous across time zones, and the
 * sync-oriented fields (source/provider/externalId) are reserved now so the
 * future Google/Outlook two-way-sync milestone won't need a data migration.
 */
export interface CalendarEvent {
  id: string
  title: string
  start: string // ISO datetime
  end: string // ISO datetime (always > start)
  allDay: boolean
  notes?: string
  source: 'local' // later: 'google' | 'outlook'
  provider?: string // external calendar id (unused for now)
  externalId?: string // id in the external provider (unused for now)
  createdAt: string
  updatedAt: string
}

/** Fields the renderer may send when creating an event. */
export interface EventCreateInput {
  title?: unknown
  start?: unknown
  end?: unknown
  allDay?: unknown
  notes?: unknown
}

/** Fields the renderer may change (any absent key is left untouched). */
export interface EventUpdateInput {
  title?: unknown
  start?: unknown
  end?: unknown
  allDay?: unknown
  notes?: unknown
}

// Ids build file paths, so they must be tightly constrained (no "../", no
// slashes) to prevent path traversal.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/
const MAX_TITLE = 300
const MAX_NOTES = 2000
const HOUR_MS = 60 * 60 * 1000

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

/** Single-line text (titles): trim, collapse newlines, bound length. */
function sanitizeTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE)
  return clean ? clean : undefined
}

/** Multi-line text (notes): keep line breaks, just bound length. */
function sanitizeNotes(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.trim().slice(0, MAX_NOTES)
  return clean ? clean : undefined
}

/** Parse an ISO-ish date string into a normalized ISO instant, or null. */
function toIso(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** Resolve a start/end pair into a valid, ordered window. */
function resolveWindow(
  startRaw: unknown,
  endRaw: unknown,
  fallbackStart: string
): { start: string; end: string } {
  const start = toIso(startRaw) ?? fallbackStart
  let end = toIso(endRaw)
  if (!end || Date.parse(end) <= Date.parse(start)) {
    end = new Date(Date.parse(start) + HOUR_MS).toISOString()
  }
  return { start, end }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function writeEvent(dir: string, event: CalendarEvent): Promise<void> {
  await fs.writeFile(join(dir, `${event.id}.json`), JSON.stringify(event, null, 2), 'utf8')
}

/** Coerce an untrusted parsed object into a clean CalendarEvent, or null. */
function sanitizeEventRecord(value: unknown): CalendarEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!isSafeId(v.id)) return null
  const title = sanitizeTitle(v.title)
  if (!title) return null
  const now = new Date().toISOString()
  const { start, end } = resolveWindow(v.start, v.end, toIso(v.start) ?? now)
  const createdAt = toIso(v.createdAt) ?? now
  return {
    id: v.id,
    title,
    start,
    end,
    allDay: v.allDay === true,
    notes: sanitizeNotes(v.notes),
    source: 'local',
    provider: typeof v.provider === 'string' ? v.provider.slice(0, 200) : undefined,
    externalId: typeof v.externalId === 'string' ? v.externalId.slice(0, 200) : undefined,
    createdAt,
    updatedAt: toIso(v.updatedAt) ?? createdAt
  }
}

export async function createEvent(dir: string, input: EventCreateInput): Promise<CalendarEvent> {
  await ensureDir(dir)
  const now = new Date().toISOString()
  const { start, end } = resolveWindow(input?.start, input?.end, now)
  const event: CalendarEvent = {
    id: randomUUID(),
    title: sanitizeTitle(input?.title) ?? 'Untitled event',
    start,
    end,
    allDay: input?.allDay === true,
    notes: sanitizeNotes(input?.notes),
    source: 'local',
    createdAt: now,
    updatedAt: now
  }
  await writeEvent(dir, event)
  return event
}

export async function listEvents(dir: string): Promise<CalendarEvent[]> {
  await ensureDir(dir)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const events: CalendarEvent[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(join(dir, file), 'utf8')
      const event = sanitizeEventRecord(JSON.parse(raw))
      if (event) events.push(event)
    } catch {
      /* skip unreadable / corrupt file */
    }
  }
  events.sort((a, b) => a.start.localeCompare(b.start)) // earliest first
  return events
}

export async function getEvent(dir: string, id: string): Promise<CalendarEvent | null> {
  if (!isSafeId(id)) return null
  try {
    const raw = await fs.readFile(join(dir, `${id}.json`), 'utf8')
    return sanitizeEventRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function updateEvent(
  dir: string,
  id: string,
  patch: EventUpdateInput
): Promise<CalendarEvent | null> {
  const event = await getEvent(dir, id)
  if (!event) return null
  if (!patch || typeof patch !== 'object') return event

  if ('title' in patch) {
    const next = sanitizeTitle(patch.title)
    if (next) event.title = next // never blank out the title
  }
  if ('allDay' in patch) event.allDay = patch.allDay === true
  if ('notes' in patch) event.notes = sanitizeNotes(patch.notes)
  // Start/end are resolved together so the window always stays valid/ordered.
  if ('start' in patch || 'end' in patch) {
    const startRaw = 'start' in patch ? patch.start : event.start
    const endRaw = 'end' in patch ? patch.end : event.end
    const { start, end } = resolveWindow(startRaw, endRaw, event.start)
    event.start = start
    event.end = end
  }
  event.updatedAt = new Date().toISOString()

  try {
    await writeEvent(dir, event)
  } catch {
    return null
  }
  return event
}

export async function deleteEvent(dir: string, id: string): Promise<{ ok: boolean }> {
  if (!isSafeId(id)) return { ok: false }
  try {
    await fs.unlink(join(dir, `${id}.json`))
  } catch {
    return { ok: false }
  }
  return { ok: true }
}
