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
  type CallSaveInput
} from './calls-fs'
import { summarize, type SummarizeInput, type SummaryResult } from './summarize'
import { coachCall, type CoachResult } from './coach'

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
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
  ipcMain.handle('calls:save', (_event, input: CallSaveInput) => saveCall(callsDir(), input))
  ipcMain.handle('calls:delete', (_event, id: string) => deleteCall(callsDir(), id))

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
}
