// IPC surface for the pre-meeting prep brief (M19 Task 3B). The renderer
// already holds the merged calendar event (local + Google + Outlook, via
// useCalendar()) — this deliberately takes that pre-merged shape as input
// rather than re-deriving calendar merging in main, which already exists
// once in the renderer and would drift if duplicated here.

import { ipcMain } from 'electron'
import {
  ensurePrepBriefForEvent,
  type PrepBriefEventInput,
  type PrepBriefAttendee,
  type PrepBriefResult
} from './prep-brief-fs'
import { isCoach2Enabled } from './app-settings'
import { loadFocusSkill } from './coaching/focus-skill-fs'
import type { FocusSkillAtCoaching } from './calls-fs'
import { rawBusinessProfileText, rawClientProfileText } from './memory/profile-injection'

/** M23 A4 — "the M19 pre-call brief displays the current Focus Skill
 *  reminder at the top." Attached OUTSIDE the cached PrepBriefRecord
 *  (never written to disk with it) so it always reflects whatever is
 *  CURRENTLY focused, even for a brief served straight from cache — a
 *  stale-but-cheap focus reminder would defeat the point of the reminder. */
async function withFocusSkillReminder(
  result: PrepBriefResult
): Promise<PrepBriefResult & { focusSkillReminder?: FocusSkillAtCoaching }> {
  if (!result.ok || !isCoach2Enabled()) return result
  const current = await loadFocusSkill()
  if (!current) return result
  return {
    ...result,
    focusSkillReminder: { skill: current.skill, microBehavior: current.microBehavior }
  }
}

/** M25 Phase 3 — "Your edge": current Focus Skill (attached separately,
 *  above) plus what Sales Brain knows about this specific client and the
 *  business's own proven objection responses. Same OUTSIDE-the-cache
 *  pattern as withFocusSkillReminder above and for the identical reason —
 *  a cached brief must never serve a stale Sales Brain snapshot, and
 *  profile-injection.ts's reads are cheap DB lookups (never an AI call),
 *  so there's no real cost to always computing this fresh. `''` sections
 *  (Sales Brain off, or nothing compiled yet) collapse to an empty string,
 *  making this genuinely absent rather than an empty-but-present field for
 *  a founder-non-technical-friendly "no Sales Brain data yet" experience. */
async function withSalesBrainEdge(
  result: PrepBriefResult,
  contactId: string | undefined
): Promise<PrepBriefResult & { salesBrainEdge?: string }> {
  if (!result.ok) return result
  const client = rawClientProfileText(contactId ?? null, 'standard')
  const business = rawBusinessProfileText('standard')
  const parts = [
    client && `About this client:\n${client}`,
    business && `Proven responses for your business:\n${business}`
  ].filter((p): p is string => Boolean(p))
  if (!parts.length) return result
  return { ...result, salesBrainEdge: parts.join('\n\n') }
}

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
    const withFocus = await withFocusSkillReminder(await ensurePrepBriefForEvent(input))
    return withSalesBrainEdge(withFocus, input.contactId)
  })

  ipcMain.handle('prepBrief:regenerate', async (_event, raw: unknown) => {
    const input = sanitizeInput(raw)
    if (!input) return { ok: false as const, error: 'failed' as const, message: 'Invalid event.' }
    const withFocus = await withFocusSkillReminder(await ensurePrepBriefForEvent(input, { force: true }))
    return withSalesBrainEdge(withFocus, input.contactId)
  })
}
