// BUG-172 — the first call after a cold launch recorded ONLY THE REP.
//
// Nineteen calls on the founder's real machine back to 2026-07-17, every one
// of them promising to record the buyer (consent.recordOtherParty: true) and
// silently not doing it. Reported the morning after a release as a suspected
// regression; it was six weeks old and the audio path had not changed.
//
// THE CHAIN, reproduced twice with the path instrumented:
//   1. status reaches 'listening' the moment the socket connects.
//   2. The auto-attach effect fires — its ONE attempt per call — and set
//      autoBuyerAttemptedRef BEFORE checking anything.
//   3. getCallId() was still null: the renderer's call id arrives with the
//      FIRST TRANSCRIPT PATCH, i.e. when somebody first speaks.
//   4. consent.persist('' , …) returns false (main refuses an empty id).
//   5. The effect returned. enableOtherParty() was never called and NOTHING
//      set otherPartyError, so no banner offered a retry.
//   6. The one attempt was spent. The call ran mono to the end.
//
// A renderer-render test cannot be written here (BUG-140), so these are
// source-level assertions on the ORDERING that was wrong, plus the constant
// that has to be time-based. The behavioural proof is three driven cold
// launches recorded in the commit message: before the fix the saved call was
// {channel: None} — only the rep — and after it, both channels.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Line endings normalised: this repo has core.autocrlf=true, so a source file
// read here is CRLF, and an anchor written with a bare newline silently never
// matches. That exact mistake broke the first version of this file.
const read = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), 'utf8').split('\r\n').join('\n')

const liveView = read('src/renderer/src/features/live/LiveView.tsx')
const hook = read('src/renderer/src/features/live/useTranscription.ts')

describe('BUG-172 — the buyer-capture attempt must not be spent before it is possible', () => {
  it('validates the call id BEFORE marking the attempt as used', () => {
    const idCheck = liveView.indexOf('const callIdNow = getCallId()')
    const markUsed = liveView.indexOf(
      'autoBuyerAttemptedRef.current = true',
      liveView.indexOf('BUG-172')
    )
    expect(idCheck, 'the call id is never read in the effect').toBeGreaterThan(-1)
    expect(markUsed, 'the attempt flag is never set').toBeGreaterThan(-1)
    // The ordering IS the bug. Reversed, the attempt is burned on a
    // precondition that has not arrived yet.
    expect(idCheck).toBeLessThan(markUsed)
  })

  it('waits on WALL CLOCK, not on how many times the effect re-ran', () => {
    // The first fix counted attempts. The effect re-runs whenever any
    // dependency changes, so ten "waits" were observed burning in FOUR
    // MILLISECONDS — the whole budget gone before a single timer fired.
    expect(liveView).toContain('BUYER_CALLID_MAX_WAIT_MS')
    expect(liveView).toContain('buyerWaitStartRef')
    expect(liveView).not.toContain('BUYER_CALLID_MAX_WAITS')
  })

  it('waits long enough for a rep who greets the buyer after pressing Start', () => {
    const m = liveView.match(/BUYER_CALLID_MAX_WAIT_MS\s*=\s*([0-9_]+)/)
    expect(m, 'the wait bound is not a literal any more').not.toBeNull()
    const ms = Number((m as RegExpMatchArray)[1].replace(/_/g, ''))
    // The id arrives on first speech. A 2.5s bound failed a 4s silence in a
    // driven run; anything under ~10s re-opens the same bug.
    expect(ms).toBeGreaterThanOrEqual(10_000)
  })

  it('SAYS SO when it gives up, instead of recording half the call in silence', () => {
    expect(hook).toContain("'not-ready'")
    expect(hook).toContain('setOtherPartyNotReady')
    expect(liveView).toContain('setOtherPartyNotReady()')
    expect(liveView).toContain('Only your side is being recorded')
  })

  it('CONTROL — the two guards inside enableOtherParty are still there', () => {
    // A cleanup pass once deleted both of these, including the CONSENT guard,
    // while removing debug logging. They are the reason capture cannot be
    // armed without a recorder or without a recorded grant.
    expect(hook).toContain('if (!recorder) return')
    expect(hook).toContain(
      "if (!before || before.status !== 'consented' || before.recordOtherParty !== true) return"
    )
  })
})

describe('BUG-173 — a live panel must be gated on the CALL, not just the setting', () => {
  it('Deal Intelligence checks the call is on screen', () => {
    expect(liveView).toContain('dealIntelligenceEnabled && liveSurfaceVisible')
  })

  it('CONTROL — that predicate actually means "a call is running"', () => {
    const m = liveView.match(/const liveSurfaceVisible =([\s\S]{0,200}?)\n\n/)
    expect(m).not.toBeNull()
    const body = (m as RegExpMatchArray)[1]
    for (const s of ['listening', 'connecting', 'reconnecting', 'paused']) {
      expect(body, `liveSurfaceVisible ignores ${s}`).toContain(s)
    }
    expect(body, 'liveSurfaceVisible would be true when idle').not.toContain("'idle'")
  })
})
