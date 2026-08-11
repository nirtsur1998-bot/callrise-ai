// IPC surface for the pre-meeting prep brief (M19 Task 3B). The renderer
// already holds the merged calendar event (local + Google + Outlook, via
// useCalendar()) — this deliberately takes that pre-merged shape as input
// rather than re-deriving calendar merging in main, which already exists
// once in the renderer and would drift if duplicated here.

import { ipcMain } from 'electron'
import {
  ensurePrepBriefForEvent,
  type PrepBriefEventInput,
  type PrepBriefAttendee
} from './prep-brief-fs'

const MAX_TITLE = 300
const MAX_ATTENDEES = 20
const MAX_EMAIL = 254
const MAX_NAME = 200

function sanitizeAttendees(value: unknown): PrepBriefAttendee[] {
  if (!Array.isArray(value)) return []
  const out: PrepBriefAttendee[] = []
  for (const item of value.slice(0, MAX_ATTENDEES)) {
    if (!item || typeof item !== 'object') continue
    const email = (item as Record<string, unknown>).email
    const name = (item as Record<string, unknown>).name
    if (typeof email !== 'string' || !email.trim()) continue
    out.push({
      email: email.trim().slice(0, MAX_EMAIL).toLowerCase(),
      ...(typeof name === 'string' && name.trim() ? { name: name.trim().slice(0, MAX_NAME) } : {})
    })
  }
  return out
}

/** Ids are used only as a hash-key and a Supabase text filter — never a file
 *  path directly — so unlike calls-fs.ts's isSafeId this only needs a
 *  sane length cap, not a charset restriction (Google/Outlook ids aren't
 *  guaranteed alphanumeric-only). */
function sanitizeInput(value: unknown): PrepBriefEventInput | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.eventId !== 'string' || !v.eventId.trim() || v.eventId.length > 500) return null
  if (typeof v.title !== 'string' || typeof v.startIso !== 'string') return null
  if (Number.isNaN(Date.parse(v.startIso))) return null
  return {
    eventId: v.eventId.trim(),
    title: v.title.trim().slice(0, MAX_TITLE),
    startIso: v.startIso,
    attendees: sanitizeAttendees(v.attendees),
    contactId: typeof v.contactId === 'string' ? v.contactId : undefined,
    dealId: typeof v.dealId === 'string' ? v.dealId : undefined
  }
}

export function registerPrepBrief(): void {
  ipcMain.handle('prepBrief:getForEvent', async (_event, raw: unknown) => {
    const input = sanitizeInput(raw)
    if (!input) return { ok: false as const, error: 'failed' as const, message: 'Invalid event.' }
    return ensurePrepBriefForEvent(input)
  })

  ipcMain.handle('prepBrief:regenerate', async (_event, raw: unknown) => {
    const input = sanitizeInput(raw)
    if (!input) return { ok: false as const, error: 'failed' as const, message: 'Invalid event.' }
    return ensurePrepBriefForEvent(input, { force: true })
  })
}
