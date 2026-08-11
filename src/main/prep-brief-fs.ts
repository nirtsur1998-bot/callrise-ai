// Storage + context assembly + content-hash caching for the pre-meeting prep
// brief (M19 Task 3B). One JSON file per calendar event (the event id is
// hashed into the filename since Google/Outlook/local event ids aren't all
// filesystem-safe or a fixed shape).
//
// Regeneration is gated on a content hash of everything the brief could
// possibly change in response to — the matched contact's own updatedAt, the
// linked deal's updatedAt, and the most recent past call's id+updatedAt —
// not a time-based TTL. Opening the same upcoming meeting's brief five times
// in a row costs one AI call, not five; editing the contact's briefing notes
// invalidates it immediately on the next open.

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeJsonAtomic } from './atomic-write'
import { getContact, findContactByEmail, type Contact } from './contacts-fs'
import { listDeals, getDeal, type Deal } from './deals-fs'
import { listCalls, getCall } from './calls-fs'
import { loadDealStages } from './deal-stages'
import { loadAppSettings } from './app-settings'
import { assemblePersonalizationContext } from './personalization-context'
import {
  generatePrepBrief,
  type PrepBrief,
  type PrepBriefContext,
  type PrepBriefGenerateResult
} from './prep-brief'

function prepBriefsDir(): string {
  return join(app.getPath('userData'), 'prep-briefs')
}
function contactsDir(): string {
  return join(app.getPath('userData'), 'contacts')
}
function dealsDir(): string {
  return join(app.getPath('userData'), 'deals')
}
function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

/** Filenames must be filesystem-safe regardless of what the event id looks
 *  like (a Google id, an Outlook id, or a local uuid) — hash it rather than
 *  trying to sanitize three different id formats consistently. */
function recordPath(eventId: string): string {
  const hash = createHash('sha256').update(eventId).digest('hex').slice(0, 32)
  return join(prepBriefsDir(), `${hash}.json`)
}

export interface PrepBriefAttendee {
  email: string
  name?: string
}

export interface PrepBriefEventInput {
  eventId: string
  title: string
  startIso: string
  attendees: PrepBriefAttendee[]
  /** Already-known link from the calendar event, if any — skips the
   *  attendee-email lookup below. */
  contactId?: string
  dealId?: string
}

export interface PrepBriefRecord {
  eventId: string
  contactId?: string
  dealId?: string
  inputHash: string
  brief: PrepBrief
  savedAt: string
}

export type PrepBriefResult =
  | { ok: true; record: PrepBriefRecord; fromCache: boolean }
  | { ok: false; error: 'no-key' | 'failed' | 'no-context'; message?: string }

async function readRecord(eventId: string): Promise<PrepBriefRecord | null> {
  try {
    const raw = await fs.readFile(recordPath(eventId), 'utf8')
    const parsed = JSON.parse(raw) as PrepBriefRecord
    return parsed && typeof parsed.inputHash === 'string' ? parsed : null
  } catch {
    return null
  }
}

async function writeRecord(record: PrepBriefRecord): Promise<void> {
  await ensureDir(prepBriefsDir())
  await writeJsonAtomic(recordPath(record.eventId), record)
}

/** The saved contact's fields the model is allowed to see, as plain text —
 *  everything from Task 3A's KYC/deal-context/personal fields, ending with
 *  the free-text briefing field (the highest-value input, since it's
 *  whatever the rep chose to write down themselves). Exported for M23
 *  Workstream B's coaching chat, which needs the exact same KYC formatting
 *  for its context assembly — one formatter, not two drifting copies. */
export function formatContactContext(c: Contact): string {
  const lines: string[] = [`Name: ${c.name}`]
  if (c.title) lines.push(`Title: ${c.title}`)
  if (c.company) lines.push(`Company: ${c.company}`)
  if (c.industry) lines.push(`Industry: ${c.industry}`)
  if (c.companySize) lines.push(`Company size: ${c.companySize}`)
  if (c.decisionAuthority) lines.push(`Decision authority: ${c.decisionAuthority}`)
  if (c.otherStakeholders) lines.push(`Other stakeholders: ${c.otherStakeholders}`)
  if (c.leadSource) lines.push(`Lead source: ${c.leadSource}`)
  if (c.budgetIndication) lines.push(`Budget indication: ${c.budgetIndication}`)
  if (c.timeline) lines.push(`Timeline: ${c.timeline}`)
  if (c.competitors) lines.push(`Competitors in play: ${c.competitors}`)
  if (c.knownObjections) lines.push(`Known objections: ${c.knownObjections}`)
  if (c.currentTooling) lines.push(`Current tooling: ${c.currentTooling}`)
  if (c.communicationStyle) lines.push(`Communication style: ${c.communicationStyle}`)
  if (c.personalNotes) lines.push(`Personal notes: ${c.personalNotes}`)
  if (c.notes) lines.push(`General notes: ${c.notes}`)
  if (c.briefingNotes) lines.push(`Briefing (rep's own notes for meeting prep): ${c.briefingNotes}`)
  return lines.join('\n')
}

function formatDealContext(d: Deal, stageLabel: string): string {
  const lines = [`Title: ${d.title}`, `Stage: ${stageLabel}`]
  if (typeof d.value === 'number') lines.push(`Value: ${d.value}`)
  if (d.expectedCloseDate) lines.push(`Expected close: ${d.expectedCloseDate}`)
  if (d.notes) lines.push(`Notes: ${d.notes}`)
  return lines.join('\n')
}

function formatLastCallContext(
  preview: string,
  summaryExecutive: string | undefined,
  when: string
): string {
  const lines = [`Date: ${when}`]
  lines.push(summaryExecutive ? `Summary: ${summaryExecutive}` : `Transcript preview: ${preview}`)
  return lines.join('\n')
}

interface AssembledContext {
  context: PrepBriefContext
  contactId?: string
  dealId?: string
  /** Everything the hash is computed over — kept separate from the prose
   *  context so a formatting-only change to the text builders above never
   *  invalidates every existing cached brief. */
  hashInputs: Record<string, string | number | undefined>
}

/** Resolves the contact/deal/last-call for one meeting and builds both the
 *  AI-facing context text and the cache-invalidation inputs. Mirrors
 *  resolve.ts's calendar-match spirit (1:1 attendee → contact by email) but
 *  simpler: a direct single-purpose lookup, not an identity cascade. */
// Exported for direct unit testing — mocking contacts-fs/deals-fs/calls-fs
// is far simpler than standing up real temp-dir fixtures for three data
// types plus the AI generation call just to exercise context assembly.
export async function assembleContext(input: PrepBriefEventInput): Promise<AssembledContext> {
  let contact: Contact | null = null
  if (input.contactId) {
    contact = await getContact(contactsDir(), input.contactId)
  } else {
    // M23 bug hunt: this used to only try matching when there was exactly
    // ONE attendee, so any group meeting (a demo with two people from the
    // buyer's side, a call with the buyer plus a colleague) silently skipped
    // contact matching entirely and produced a near-empty brief — no error,
    // no indication matching was even attempted. Try every attendee's email
    // now; the first one that resolves to a known contact wins. Order
    // follows whatever order the calendar API returned attendees in — not a
    // perfect "which one is the buyer" signal, but strictly better than
    // skipping every meeting with more than one attendee.
    for (const attendee of input.attendees) {
      if (!attendee.email) continue
      const match = await findContactByEmail(contactsDir(), attendee.email)
      if (match) {
        contact = match
        break
      }
    }
  }

  let deal: Deal | null = null
  if (input.dealId) {
    deal = await getDeal(dealsDir(), input.dealId)
  } else if (contact) {
    const stages = loadDealStages()
    const openStageIds = new Set(stages.filter((s) => s.kind === 'open').map((s) => s.id))
    const contactDeals = (await listDeals(dealsDir()))
      .filter((d) => d.contactId === contact!.id && openStageIds.has(d.stageId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    deal = contactDeals[0] ?? null
  }

  let lastCallSummary = ''
  let lastCallId: string | undefined
  let lastCallUpdatedAt: string | undefined
  if (contact) {
    const pastCalls = (await listCalls(callsDir()))
      .filter((c) => c.contactId === contact!.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const mostRecent = pastCalls[0]
    if (mostRecent) {
      const full = await getCall(callsDir(), mostRecent.id)
      if (full) {
        lastCallId = full.id
        lastCallUpdatedAt = full.updatedAt
        lastCallSummary = formatLastCallContext(
          full.preview,
          full.summary?.executive,
          full.createdAt
        )
      }
    }
  }

  const attendeesText = input.attendees
    .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
    .join(', ')

  const stageLabel = deal
    ? (loadDealStages().find((s) => s.id === deal!.stageId)?.label ?? deal.stageId)
    : ''

  const personalization = (() => {
    try {
      return assemblePersonalizationContext(loadAppSettings().personalization)
    } catch {
      return ''
    }
  })()

  return {
    context: {
      meetingTitle: input.title,
      meetingStartIso: input.startIso,
      attendees: attendeesText,
      contactContext: contact ? formatContactContext(contact) : '',
      dealContext: deal ? formatDealContext(deal, stageLabel) : '',
      lastCallContext: lastCallSummary,
      personalization
    },
    contactId: contact?.id,
    dealId: deal?.id,
    hashInputs: {
      title: input.title,
      startIso: input.startIso,
      attendees: attendeesText,
      contactId: contact?.id,
      contactUpdatedAt: contact?.updatedAt,
      dealId: deal?.id,
      dealUpdatedAt: deal?.updatedAt,
      lastCallId,
      lastCallUpdatedAt,
      // M23 bug hunt: personalization wasn't part of the cache key, so
      // editing personalization settings (tone, style, etc.) after a brief
      // was cached had no effect on that meeting's brief until a manual
      // "Regenerate" — reopening it kept silently serving the stale version.
      personalization
    }
  }
}

export function computeInputHash(hashInputs: Record<string, string | number | undefined>): string {
  const stable = Object.keys(hashInputs)
    .sort()
    .map((k) => `${k}=${hashInputs[k] ?? ''}`)
    .join('|')
  return createHash('sha256').update(stable).digest('hex')
}

/** The main entry point: returns a cached brief if the underlying contact/
 *  deal/call-history hasn't changed since it was generated, otherwise
 *  generates a fresh one (billing exactly one AI call) and caches it.
 *  `force: true` (the UI's "Regenerate" action) always calls the AI. */
export async function ensurePrepBriefForEvent(
  input: PrepBriefEventInput,
  opts?: { force?: boolean }
): Promise<PrepBriefResult> {
  const assembled = await assembleContext(input)
  const inputHash = computeInputHash(assembled.hashInputs)

  if (!opts?.force) {
    const existing = await readRecord(input.eventId)
    if (existing && existing.inputHash === inputHash) {
      return { ok: true, record: existing, fromCache: true }
    }
  }

  const result: PrepBriefGenerateResult = await generatePrepBrief(assembled.context)
  if (!result.ok) return result

  const record: PrepBriefRecord = {
    eventId: input.eventId,
    contactId: assembled.contactId,
    dealId: assembled.dealId,
    inputHash,
    brief: result.brief,
    savedAt: new Date().toISOString()
  }
  await writeRecord(record)
  return { ok: true, record, fromCache: false }
}

/** Read-only — used by the alert-dispatcher's local desktop-notification
 *  path (main is already running, so it can serve a cached/fresh brief for
 *  the condensed push text without a second round trip through the deep
 *  link). Returns null rather than generating, since this runs off the
 *  meeting_starting desktop delivery path which must stay fast. */
export async function getCachedPrepBrief(eventId: string): Promise<PrepBriefRecord | null> {
  return readRecord(eventId)
}
