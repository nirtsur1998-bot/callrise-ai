// BUG-249 — BUG-D's trap wrote its line before the frame carrying the answer.
//
// M37 built the trap on a true observation: Deepgram answers the branch
// question itself, unprompted, in a `Metadata` frame carrying the channel
// count THE SERVER received and a `request_id`. What nobody checked is WHEN
// that frame arrives relative to when the summary is written. Deepgram sends
// it in response to CloseStream, at the end of a session;
// `logSessionSummary()` runs at the TOP of the `transcription:stop` handler,
// before anything closes the socket.
//
// So on the first real call ever run through the trap — a clean 59-second
// session, `socketOpens=1`, `socketErrors=0`, `frames={"SpeechStarted":36}`
// proving non-Results frames WERE being received and counted — the two fields
// the trap exists for came out `serverChannels=unknown requestId=none`.
//
// THE FAILURE MODE IS THE DANGEROUS KIND, and the founder named it: an
// instrument that produces output, on the happy path, that looks like a
// result. The reader concludes "the trap fired and told us nothing" rather
// than "the trap cannot fire correctly", and BUG-D's remaining branch stays
// undecided while looking decided.
//
// These are SOURCE-ORDER assertions rather than a driven session, because the
// defect is an ordering between two call sites and a network frame. A driven
// test would need Deepgram to send Metadata on a schedule, which is the thing
// we do not control and the reason the ordering matters.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RAW = readFileSync(join(__dirname, '..', 'transcription.ts'), 'utf8')

/** Comments stripped, and the first draft of this file is why: `indexOf("ws.on('close'")`
 *  matched a COMMENT forty thousand characters above the handler
 *  ("`ws.on('close')` took no arguments at all"), so every offset assertion
 *  below was measuring the wrong place. It failed rather than passing wrongly
 *  this time; the same match with luckier offsets would have passed. A guard
 *  that can match its own explanation is not a guard — the rule this codebase
 *  already applies in no-false-locality-claims and the BUG-206 tests. */
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

describe('BUG-249 — the late fields are written where they are finally true', () => {
  it('writes a second line from the socket close handler', () => {
    expect(SRC).toContain('function logSessionClose(')
    // Called from ws.on('close') — the one place lastCloseCode, lastCloseReason,
    // serverChannels and requestId are all simultaneously true.
    const closeHandler = SRC.slice(SRC.indexOf("ws.on('close'"))
    expect(closeHandler.slice(0, 1200)).toContain('logSessionClose(s)')
  })

  it('carries the four fields the stop-time line cannot have', () => {
    const fn = SRC.slice(SRC.indexOf('function logSessionClose('))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    for (const field of ['serverChannels=', 'requestId=', 'closeCode=', 'closeReason=']) {
      expect(body, `the close line dropped ${field}`).toContain(field)
    }
  })

  it('KEEPS the stop-time summary rather than moving it', () => {
    // The obvious repair was to move the existing call after the close. That
    // trades a summary that is ALWAYS written for a better one that is not:
    // a session which dies without a clean close still gets the first line,
    // and those are exactly the sessions most worth diagnosing.
    expect(SRC).toContain('function logSessionSummary(')
    const stopHandler = SRC.slice(SRC.indexOf("ipcMain.handle('transcription:stop'"))
    expect(stopHandler.slice(0, 900)).toContain('logSessionSummary(s)')
    // failSession keeps it too — the crash path is the whole reason it stays.
    const failFn = SRC.slice(SRC.indexOf('function failSession('))
    expect(failFn.slice(0, 400)).toContain('logSessionSummary(s)')
  })

  it('logs the close for a SUPERSEDED session too', () => {
    // Placed above the `session !== s` return: a reconnect closes a socket,
    // and that connection's serverChannels/requestId are exactly what BUG-D
    // wants. `socketOpens` counts those connections; only this line can
    // describe them.
    const handler = SRC.slice(SRC.indexOf("ws.on('close'"))
    const logAt = handler.indexOf('logSessionClose(s)')
    const returnAt = handler.indexOf('if (session !== s) return')
    expect(logAt).toBeGreaterThan(-1)
    expect(returnAt).toBeGreaterThan(-1)
    expect(logAt, 'the close line must be written before the superseded-session return').toBeLessThan(returnAt)
  })

  it('cannot break a live call — the writer is wrapped, like its sibling', () => {
    const fn = SRC.slice(SRC.indexOf('function logSessionClose('))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toContain('try {')
    expect(body).toContain('catch')
  })
})
