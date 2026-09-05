// BUG-188 — the "still running in the tray" notice: once per install, only
// when the app actually keeps running, and never able to break the close.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteMainWindowClosedToTray, TRAY_NOTICE, TRAY_NOTICE_MARKER } from '../tray-notice'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tray-notice-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('noteMainWindowClosedToTray', () => {
  it('shows once, writes the marker, and is silent the second time', () => {
    const show = vi.fn()
    expect(noteMainWindowClosedToTray(dir, true, show)).toBe(true)
    expect(show).toHaveBeenCalledWith(TRAY_NOTICE)
    expect(existsSync(join(dir, TRAY_NOTICE_MARKER))).toBe(true)
    expect(noteMainWindowClosedToTray(dir, true, show)).toBe(false)
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('says nothing when the app is actually quitting — there is nothing to warn about', () => {
    const show = vi.fn()
    expect(noteMainWindowClosedToTray(dir, false, show)).toBe(false)
    expect(show).not.toHaveBeenCalled()
    expect(existsSync(join(dir, TRAY_NOTICE_MARKER))).toBe(false)
  })

  it('an existing marker from a previous install run keeps it silent', () => {
    writeFileSync(join(dir, TRAY_NOTICE_MARKER), '{}')
    const show = vi.fn()
    expect(noteMainWindowClosedToTray(dir, true, show)).toBe(false)
    expect(show).not.toHaveBeenCalled()
  })

  it('a notification that throws cannot break the close', () => {
    const show = vi.fn(() => {
      throw new Error('no notification support')
    })
    expect(() => noteMainWindowClosedToTray(dir, true, show)).not.toThrow()
  })

  it('the words say what it does and how to stop it', () => {
    expect(TRAY_NOTICE.body).toMatch(/tray/i)
    expect(TRAY_NOTICE.body).toMatch(/quit/i)
    expect(TRAY_NOTICE.body).toMatch(/still detected/i)
  })
})
