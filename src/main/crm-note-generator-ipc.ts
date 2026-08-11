// M23 Workstream C — IPC surface for the standalone CRM Note Generator card
// on the Contact page. Unlike Workstream B's per-call regenerateCrmNote,
// this is contact-scoped: it finds that contact's own most recent linked
// call itself, so the renderer never has to know or pass a callId.
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { listCalls, getCall } from './calls-fs'
import { getContact, addComment } from './contacts-fs'
import { generateCrmNote } from './crm-notes'
import { sanitizeCrmNoteLength, type CrmNoteLength } from './crm-note-length'
import { crmNoteSourceFromCall, harvestKycFacts, type KycFact } from './crm-note-generator'
import { applyKycField } from './kyc-apply'
import { isNoteGeneratorEnabled } from './app-settings'
import { scheduleBackup } from './backup'

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}
function contactsDir(): string {
  return join(app.getPath('userData'), 'contacts')
}

const DISABLED_MESSAGE = 'The CRM Note Generator is off — turn it on in Settings → CRM.'

async function mostRecentCallIdForContact(contactId: string): Promise<string | null> {
  const summaries = await listCalls(callsDir())
  const related = summaries
    .filter((s) => s.contactId === contactId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return related[0]?.id ?? null
}

export interface CrmNoteGeneratorResult {
  ok: boolean
  note?: string
  facts?: KycFact[]
  message?: string
}

async function handleGenerate(contactId: string, rawLength: unknown): Promise<CrmNoteGeneratorResult> {
  if (!isNoteGeneratorEnabled()) return { ok: false, message: DISABLED_MESSAGE }
  const length: CrmNoteLength = sanitizeCrmNoteLength(rawLength)

  const contact = await getContact(contactsDir(), contactId)
  if (!contact) return { ok: false, message: 'Contact not found.' }

  const callId = await mostRecentCallIdForContact(contactId)
  if (!callId) return { ok: false, message: 'Link a call to this contact first.' }
  const call = await getCall(callsDir(), callId)
  if (!call) return { ok: false, message: 'Link a call to this contact first.' }

  const source = crmNoteSourceFromCall(call)
  if (!source.trim()) {
    return { ok: false, message: 'This call has no transcript or summary to draft from yet.' }
  }

  const [noteResult, facts] = await Promise.all([
    generateCrmNote(source, length),
    harvestKycFacts(source, contact)
  ])
  if (!noteResult.ok) return { ok: false, message: 'Could not draft a note. Please try again.' }

  return { ok: true, note: noteResult.note, facts }
}

let registered = false

export function registerCrmNoteGenerator(): void {
  if (registered) return
  registered = true

  ipcMain.handle(
    'crmNoteGenerator:generate',
    async (_e, contactId: string, length: unknown): Promise<CrmNoteGeneratorResult> => {
      try {
        return await handleGenerate(contactId, length)
      } catch {
        return { ok: false, message: 'Something went wrong. Please try again.' }
      }
    }
  )

  ipcMain.handle(
    'crmNoteGenerator:save',
    async (_e, contactId: string, note: string): Promise<{ ok: boolean }> => {
      try {
        if (!isNoteGeneratorEnabled()) return { ok: false }
        const text = typeof note === 'string' ? note.trim() : ''
        if (!text) return { ok: false }
        const contact = await addComment(contactsDir(), contactId, text, 'ai')
        if (contact) scheduleBackup()
        return { ok: !!contact }
      } catch {
        return { ok: false }
      }
    }
  )

  ipcMain.handle(
    'crmNoteGenerator:applyFact',
    async (_e, contactId: string, field: string, text: string): Promise<{ ok: boolean }> => {
      try {
        if (!isNoteGeneratorEnabled()) return { ok: false }
        const contact = await applyKycField(contactsDir(), contactId, field, text)
        if (contact) scheduleBackup()
        return { ok: !!contact }
      } catch {
        return { ok: false }
      }
    }
  )
}
