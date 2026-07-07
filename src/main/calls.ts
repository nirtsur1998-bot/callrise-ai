import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import mammoth from 'mammoth'
import {
  saveCall,
  listCalls,
  getCall,
  deleteCall,
  addAttachment,
  removeAttachment,
  readAttachment,
  setCallSummary,
  setAttachmentSummary,
  setCallCoaching,
  setCallTitle,
  setCallContact,
  setCallObjectionsMined,
  type CallSaveInput,
  type CallSummary
} from './calls-fs'
import { summarize, type SummarizeInput, type SummaryResult } from './summarize'
import { coachCall, type CoachResult } from './coach'
import { generateCallTitle, type GenerateTitleResult } from './call-title'
import { mineObjections, makeVerifier, type ObjectionMiningResult } from './objection-mining'
import { addToQueue, purgeQueueForCall } from './objection-queue-fs'
import { isObjectionMiningEnabled } from './app-settings'
import { scheduleBackup } from './backup'

function objectionQueueDir(): string {
  return join(app.getPath('userData'), 'objection-queue')
}

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}

/** Calls with a mining request currently in flight. The mined-at flag is only
 *  written AFTER the (slow) AI call returns, so without this set an auto-mine
 *  racing the manual scan — or two overlapping scans — would mine the same
 *  call twice and duplicate its candidates in the review queue. */
const miningInFlight = new Set<string>()
let scanInFlight = false

/** Mine one call and stage any grounded candidates in the review queue, then
 *  mark the call as mined — shared by the new-call auto-mine hook and the
 *  manual "scan past calls" trigger. Only marks the call mined on SUCCESS, so
 *  a transient failure (e.g. a rate limit) leaves it eligible for a retry. */
async function mineCallIntoQueue(callId: string): Promise<{ ok: boolean; added: number }> {
  if (miningInFlight.has(callId)) return { ok: false, added: 0 }
  miningInFlight.add(callId)
  try {
    const call = await getCall(callsDir(), callId)
    if (!call?.segments?.length) return { ok: false, added: 0 }
    // Re-check on the fresh read: another path may have finished mining this
    // call after the caller built its eligible list.
    if (call.objectionsMinedAt) return { ok: true, added: 0 }
    const result = await mineObjections(call.segments)
    if (!result.ok) return { ok: false, added: 0 }
    const items = await addToQueue(objectionQueueDir(), result.candidates, callId, call.title)
    await setCallObjectionsMined(callsDir(), callId)
    return { ok: true, added: items.length }
  } finally {
    miningInFlight.delete(callId)
  }
}

/** A call is "eligible" for mining once it has a transcript and hasn't been
 *  mined yet — shared by the scan estimate and the scan itself so the count
 *  shown before confirming always matches what the scan will actually do. */
function eligibleForMining(calls: CallSummary[]): CallSummary[] {
  return calls.filter(
    (c) => !c.objectionsMined && typeof c.preview === 'string' && c.preview.trim().length > 0
  )
}

/** Extract text from a .docx. Returns null when the file can't be parsed at all. */
async function extractDocxText(bytes: Buffer): Promise<string | null> {
  try {
    const result = await mammoth.extractRawText({ buffer: bytes })
    return result.value ?? ''
  } catch {
    return null
  }
}

/** Cheap heuristic that a UTF-8-decoded buffer is actually readable text. */
function looksLikeText(text: string): boolean {
  if (text.length === 0) return false
  const sample = text.slice(0, 4000)
  let bad = 0
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i)
    // U+FFFD (replacement char from a bad decode) or a NUL byte signals binary.
    if (code === 0xfffd || code === 0) bad++
  }
  return bad / sample.length < 0.1
}

const SAVE_FAILED: SummaryResult = {
  ok: false,
  error: 'failed',
  message: 'The summary could not be saved. Please try again.'
}

let registered = false

export function registerCalls(): void {
  if (registered) return
  registered = true

  ipcMain.handle('calls:list', () => listCalls(callsDir()))
  ipcMain.handle('calls:get', (_event, id: string) => getCall(callsDir(), id))
  ipcMain.handle('calls:save', async (_event, input: CallSaveInput) => {
    const summary = await saveCall(callsDir(), input)
    scheduleBackup() // metadata only reaches the cloud (segments never included)
    // Fire-and-forget: never block the save on an AI call. Only runs when the
    // Objection Library toggle is on — this is the "new calls going forward"
    // half of the mining scope (the other half is the manual scan below).
    if (isObjectionMiningEnabled()) {
      void mineCallIntoQueue(summary.id).catch(() => {})
    }
    return summary
  })
  ipcMain.handle('calls:delete', async (_event, id: string) => {
    const res = await deleteCall(callsDir(), id)
    // The review queue stages verbatim buyer quotes mined from this call —
    // deleting the call must take them with it, or "a deleted call keeps no
    // buyer words" (deleteCall's guarantee) would be false one folder over.
    await purgeQueueForCall(objectionQueueDir(), id).catch(() => 0)
    scheduleBackup() // propagate the deletion tombstone
    return res
  })

  // --- Attachments ---------------------------------------------------------
  ipcMain.handle(
    'calls:addAttachment',
    (_event, callId: string, file: { name?: string; ext?: string; data?: ArrayBuffer }) => {
      const bytes = file?.data instanceof ArrayBuffer ? new Uint8Array(file.data) : new Uint8Array()
      return addAttachment(callsDir(), callId, { name: file?.name, ext: file?.ext, bytes })
    }
  )
  ipcMain.handle('calls:removeAttachment', (_event, callId: string, attachmentId: string) =>
    removeAttachment(callsDir(), callId, attachmentId)
  )

  // --- CRM: link this call to a contact -------------------------------------
  ipcMain.handle('calls:setContact', async (_event, callId: string, contactId: string | null) => {
    const call = await setCallContact(callsDir(), callId, contactId)
    scheduleBackup() // the link is metadata like a title edit
    return call
  })

  // --- AI summaries --------------------------------------------------------
  ipcMain.handle('summary:call', async (_event, callId: string): Promise<SummaryResult> => {
    try {
      const call = await getCall(callsDir(), callId)
      if (!call) return { ok: false, error: 'failed', message: 'Call not found.' }
      if (!call.segments?.length) {
        return { ok: false, error: 'failed', message: 'This call has no transcript to summarize.' }
      }
      const text = call.segments.map((s) => `Speaker ${s.speaker + 1}: ${s.text}`).join('\n')
      const result = await summarize({ kind: 'text', text })
      if (result.ok) {
        const saved = await setCallSummary(callsDir(), callId, result.summary)
        if (!saved) return SAVE_FAILED
        scheduleBackup() // the summary (paraphrase, not the transcript) syncs
      }
      return result
    } catch {
      return SAVE_FAILED
    }
  })

  ipcMain.handle(
    'summary:attachment',
    async (_event, callId: string, attachmentId: string): Promise<SummaryResult> => {
      try {
        const file = await readAttachment(callsDir(), callId, attachmentId)
        if (!file) return { ok: false, error: 'failed', message: 'File not found.' }

        let input: SummarizeInput
        if (file.ext === 'pdf') {
          input = { kind: 'pdf', base64: file.bytes.toString('base64') }
        } else if (file.ext === 'docx') {
          const text = await extractDocxText(file.bytes)
          if (text === null) {
            return {
              ok: false,
              error: 'failed',
              message: "This .docx file appears to be corrupt or isn't a valid Word document."
            }
          }
          if (!text.trim()) {
            return {
              ok: false,
              error: 'failed',
              message: 'Could not read any text from this .docx file.'
            }
          }
          input = { kind: 'text', text }
        } else {
          const text = file.bytes.toString('utf8')
          if (!looksLikeText(text)) {
            return {
              ok: false,
              error: 'failed',
              message: "This file doesn't look like readable text."
            }
          }
          input = { kind: 'text', text }
        }

        const result = await summarize(input)
        if (result.ok) {
          const saved = await setAttachmentSummary(callsDir(), callId, attachmentId, result.summary)
          if (!saved) return SAVE_FAILED
        }
        return result
      } catch {
        return SAVE_FAILED
      }
    }
  )

  // --- AI coaching ---------------------------------------------------------
  ipcMain.handle('coach:call', async (_event, callId: string): Promise<CoachResult> => {
    try {
      const call = await getCall(callsDir(), callId)
      if (!call) return { ok: false, error: 'failed', message: 'Call not found.' }
      if (!call.segments?.length) {
        return { ok: false, error: 'failed', message: 'This call has no transcript to coach.' }
      }
      const result = await coachCall(call.segments, call.durationMs)
      if (result.ok) {
        const saved = await setCallCoaching(callsDir(), callId, result.report)
        if (!saved) {
          return {
            ok: false,
            error: 'failed',
            message: 'The coaching report could not be saved. Please try again.'
          }
        }
        scheduleBackup() // quote-free scores/advice sync; evidence quotes never do
      }
      return result
    } catch {
      return {
        ok: false,
        error: 'failed',
        message: 'The coaching report could not be saved. Please try again.'
      }
    }
  })

  // --- Objection Library: mine a call for raw candidates --------------------
  // Gated on the SAME toggle that will later gate new-call mining + the
  // manual "scan past calls" trigger — nothing here runs while it's off.
  ipcMain.handle(
    'objections:mineTest',
    async (_event, callId: string): Promise<ObjectionMiningResult> => {
      if (!isObjectionMiningEnabled()) {
        return {
          ok: false,
          error: 'disabled',
          message: 'Turn on "Learn objection responses from my calls" in Settings first.'
        }
      }
      try {
        const call = await getCall(callsDir(), callId)
        if (!call) return { ok: false, error: 'failed', message: 'Call not found.' }
        if (!call.segments?.length) {
          return { ok: false, error: 'failed', message: 'This call has no transcript to mine.' }
        }
        return await mineObjections(call.segments)
      } catch {
        return {
          ok: false,
          error: 'failed',
          message: 'Something went wrong while mining this call. Please try again.'
        }
      }
    }
  )

  // Send raw mined candidates (from objections:mineTest) into the review
  // queue. Still gated on the toggle — the whole mining workflow is off
  // when the setting is off, not just the first step of it.
  ipcMain.handle(
    'objections:enqueue',
    async (
      _event,
      callId: string,
      candidates: unknown
    ): Promise<{ ok: boolean; added: number }> => {
      if (!isObjectionMiningEnabled()) return { ok: false, added: 0 }
      try {
        const call = await getCall(callsDir(), callId)
        if (!call) return { ok: false, added: 0 }
        // Never trust the renderer's "verified" booleans — re-run the same
        // transcript check mining used, against THIS call's segments. This
        // also catches candidates mined from one call but enqueued under
        // another call's id.
        const verify = makeVerifier(call.segments ?? [])
        const list = (Array.isArray(candidates) ? candidates : []).map((raw) => {
          if (!raw || typeof raw !== 'object') return raw
          const c = raw as Record<string, unknown>
          return {
            ...c,
            objectionVerified: verify(c.objectionQuote, c.objectionSpeaker),
            responseVerified: verify(c.responseQuote, c.responseSpeaker)
          }
        })
        const items = await addToQueue(objectionQueueDir(), list, callId, call.title)
        // The call HAS been mined (via mineTest) — mark it so the past-calls
        // scan doesn't mine it again and duplicate these candidates.
        await setCallObjectionsMined(callsDir(), callId)
        return { ok: true, added: items.length }
      } catch {
        return { ok: false, added: 0 }
      }
    }
  )

  // How many past calls are eligible (have a transcript, not yet mined) —
  // shown before the user confirms the manual scan below.
  ipcMain.handle('objections:scanEstimate', async (): Promise<{ eligibleCount: number }> => {
    if (!isObjectionMiningEnabled()) return { eligibleCount: 0 }
    const calls = await listCalls(callsDir())
    return { eligibleCount: eligibleForMining(calls).length }
  })

  // The manual "scan my past calls" trigger — only ever runs when the user
  // clicks it (never automatically), one call at a time so a slow or rate-
  // limited request can't pile up concurrent API calls.
  ipcMain.handle(
    'objections:scanPastCalls',
    async (): Promise<{
      ok: boolean
      scanned: number
      candidatesAdded: number
      failed: number
      stopped?: 'disabled' | 'errors'
    }> => {
      if (!isObjectionMiningEnabled()) {
        return { ok: false, scanned: 0, candidatesAdded: 0, failed: 0 }
      }
      // One scan at a time, enforced HERE — the renderer's disabled button
      // resets on remount, so it can't be the only guard.
      if (scanInFlight) return { ok: false, scanned: 0, candidatesAdded: 0, failed: 0 }
      scanInFlight = true
      try {
        const calls = await listCalls(callsDir())
        const eligible = eligibleForMining(calls)
        let scanned = 0
        let candidatesAdded = 0
        let failed = 0
        let consecutiveFailures = 0
        for (const c of eligible) {
          // The toggle is the HARD gate ("off means no call is ever read") —
          // honor a mid-scan flip instead of only checking once at the start.
          if (!isObjectionMiningEnabled()) {
            return { ok: true, scanned, candidatesAdded, failed, stopped: 'disabled' }
          }
          const res = await mineCallIntoQueue(c.id)
          if (res.ok) {
            scanned++
            candidatesAdded += res.added
            consecutiveFailures = 0
          } else {
            failed++
            // A run of failures means the API is down/rate-limited — stop
            // instead of burning a doomed request per remaining call. The
            // unmined calls stay eligible for a later retry.
            if (++consecutiveFailures >= 3) {
              return { ok: true, scanned, candidatesAdded, failed, stopped: 'errors' }
            }
          }
        }
        return { ok: true, scanned, candidatesAdded, failed }
      } finally {
        scanInFlight = false
      }
    }
  )

  // AI Note Taker's auto-title feature: generate + save a title in one step.
  ipcMain.handle(
    'calls:generateTitle',
    async (_event, callId: string): Promise<GenerateTitleResult> => {
      try {
        const call = await getCall(callsDir(), callId)
        if (!call?.segments?.length) return { ok: false }
        const result = await generateCallTitle(call.segments)
        if (!result.ok) return result
        const saved = await setCallTitle(callsDir(), callId, result.title)
        if (!saved) return { ok: false }
        scheduleBackup() // the new title reaches the cloud like any other metadata edit
        return { ok: true, title: saved.title }
      } catch {
        return { ok: false }
      }
    }
  )
}
