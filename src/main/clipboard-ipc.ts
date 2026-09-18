// Copying, from the MAIN process — because the renderer cannot.
//
// FOUND BY THE FOUNDER, 2026-09-18, on the new CRM-note Copy button: "I tried
// to press on the copy button and the markdown - both didn't paste anything."
// Measured in the running app immediately after:
//
//   navigator.clipboard.writeText(...) -> NotAllowedError: Write permission denied
//   navigator.clipboard.write([...])   -> NotAllowedError: Write permission denied
//
// The renderer is a `file://` document, and index.ts's permission handlers
// deny every permission except `media` — deliberately, and correctly. So the
// whole Async Clipboard API is unavailable to this app, and always has been:
// this is NOT specific to the new button. `CallDetail`'s "Copy transcript" and
// the Telegram deep-link copy call the same API and have never worked either
// (BUG-288). Nothing reported it, because a clipboard write that fails looks
// exactly like one that succeeded — you find out at the paste.
//
// Electron's own clipboard module runs in main, outside that permission model,
// and writes text and HTML in one go — which is also what the CRM-note paste
// needs, since a rich-text CRM field collapses plain-text newlines.
//
// Loosening the permission handler was the alternative and was rejected: it is
// a security boundary that currently says "media, nothing else", and widening
// it for a convenience feature is the wrong trade.
import { clipboard, ipcMain } from 'electron'

export interface ClipboardWritePayload {
  text: string
  /** Optional rich-text flavour. Written alongside the plain text, never
   *  instead of it, so a plain textarea still gets something sensible. */
  html?: string
}

/** Validated in main: the renderer is the untrusted side of this boundary,
 *  and `clipboard.write` will throw on a non-string. */
export function sanitizeClipboardPayload(value: unknown): ClipboardWritePayload | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const text = typeof v.text === 'string' ? v.text : ''
  if (!text.trim()) return null
  const html = typeof v.html === 'string' && v.html.trim() ? v.html : undefined
  return html ? { text, html } : { text }
}

export function registerClipboardIpc(): void {
  ipcMain.handle('clipboard:write', (_e, payload: unknown): { ok: boolean } => {
    const clean = sanitizeClipboardPayload(payload)
    if (!clean) return { ok: false }
    try {
      // `write` (not writeText) so the html flavour lands too. Electron puts
      // both on the clipboard and the destination picks the one it can use.
      clipboard.write(clean.html ? { text: clean.text, html: clean.html } : { text: clean.text })
      return { ok: true }
    } catch (err) {
      console.error('[clipboard] write failed:', err)
      return { ok: false }
    }
  })
}
