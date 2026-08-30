import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { traceSummary, traceHasGaps } from '../traceSummary'
import type { AssistantTraceStep } from '../../../../../preload/index.d'

/**
 * M31 Stage 5 item 4 — the collapsed line of the stream-of-thought.
 *
 * The founder's constraint was not about formatting. It was that the trace
 * must show what ACTUALLY happened, including the outcomes that produced
 * nothing: *"Looked for Ben's past calls · none found" is more trustworthy
 * than silence, and it's the difference between showing work and showing
 * intent.*
 *
 * Which makes the collapsed line load-bearing. Someone opens a reasoning
 * trace because an answer surprised them — and "a lookup came back empty" is
 * usually why. A summary that says "3 steps" hides precisely the fact they
 * came to find, so these tests pin that empties and failures survive the
 * collapse.
 */

const step = (
  status: AssistantTraceStep['status'],
  label = 'Searched your calls'
): AssistantTraceStep => ({ label, status })

describe('the collapsed line keeps the unhappy outcomes visible', () => {
  it('says when a lookup found nothing, without being opened', () => {
    const s = traceSummary([step('ok'), step('none')])
    expect(s).toContain('found nothing')
  })

  it('says when a lookup failed, without being opened', () => {
    expect(traceSummary([step('ok'), step('failed')])).toContain('failed')
  })

  it('reports empties and failures separately — they are different facts', () => {
    // "I looked and there was nothing" and "I tried and it broke" say very
    // different things about how much to trust the answer.
    const s = traceSummary([step('ok'), step('none'), step('failed')])
    expect(s).toContain('1 found nothing')
    expect(s).toContain('1 failed')
  })

  it('counts only what actually contributed as a source used', () => {
    const s = traceSummary([step('ok'), step('ok'), step('none'), step('failed')])
    expect(s).toContain('2 sources used')
    expect(s, 'an empty or failed lookup must not be counted as a source').not.toContain(
      '4 sources'
    )
    expect(s).not.toContain('3 sources')
  })

  it('does not say "1 sources"', () => {
    expect(traceSummary([step('ok')])).toContain('1 source used')
    expect(traceSummary([step('ok')])).not.toContain('1 sources')
  })

  it('a skipped capability is not miscounted as a success or a failure', () => {
    // Sales Brain switched off is neither — it is a thing that did not run.
    const s = traceSummary([step('ok'), step('skipped')])
    expect(s).toContain('1 source used')
    expect(s).not.toContain('failed')
    expect(s).not.toContain('found nothing')
  })

  it('renders nothing rather than an empty claim when there are no steps', () => {
    expect(traceSummary([])).toBe('How Rise answered this')
  })
})

describe('gaps are flagged before the reader opens it', () => {
  it('is true when anything came back empty or broken', () => {
    expect(traceHasGaps([step('ok'), step('none')])).toBe(true)
    expect(traceHasGaps([step('ok'), step('failed')])).toBe(true)
  })

  it('is false when everything worked', () => {
    expect(traceHasGaps([step('ok'), step('ok')])).toBe(false)
  })

  it('a skipped step is not a gap', () => {
    // Sales Brain being off is a setting, not a shortfall in the answer.
    expect(traceHasGaps([step('ok'), step('skipped')])).toBe(false)
  })
})

describe('the disclosure obeys the founder’s presentation constraints', () => {
  const SRC = readFileSync(join(__dirname, '..', 'TraceDisclosure.tsx'), 'utf8')
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('defaults to collapsed', () => {
    expect(code).toMatch(/useState\(false\)/)
  })

  it('has no open/close animation on the content', () => {
    // "no animation drama on open" — the rows simply exist. A height or fade
    // transition on the list is exactly what was ruled out; the chevron's
    // rotate is the one permitted motion.
    const list = code.slice(code.indexOf('{open && ('))
    expect(list, 'the expanded content animates').not.toMatch(
      /animate-|transition-\[height\]|transition-all|duration-/
    )
  })

  it('never colours an empty result as a problem', () => {
    // A normal, honest "nothing matched" must not read as a warning, or a
    // complete answer starts looking broken.
    const statusClass = code.slice(code.indexOf('STATUS_CLASS'), code.indexOf('export function'))
    expect(statusClass).toMatch(/none:\s*'text-faint'/)
    expect(statusClass).not.toMatch(/none:\s*'text-(warning|danger)'/)
  })
})
