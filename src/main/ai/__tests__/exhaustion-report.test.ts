// The per-model breakdown shown when every model fails. This string is an
// EVIDENCE CHANNEL: on a machine whose logs cannot leave it (the founder's
// work PC), what it carries is everything a diagnosis gets. So the tests pin
// the properties that make evidence usable — verbatim reasons, bounded
// length, and the identical-reason collapse that turns "5 failures" into the
// single most diagnostic fact there is.
import { describe, expect, it } from 'vitest'
import { exhaustionReport } from '../exhaustion-report'

const SUMMARY = 'Every configured model failed to respond just now.'

describe('exhaustionReport', () => {
  it('with no attempts, the summary passes through untouched', () => {
    expect(exhaustionReport(SUMMARY, undefined)).toBe(SUMMARY)
    expect(exhaustionReport(SUMMARY, [])).toBe(SUMMARY)
  })

  it('names each model with its verbatim reason', () => {
    const out = exhaustionReport(SUMMARY, [
      { catalogId: 'groq-llama-3.3-70b-versatile', reason: 'rate-limit: 413 request too large for tokens per minute' },
      { catalogId: 'cerebras-gpt-oss-120b', reason: 'timeout' }
    ])
    expect(out).toContain(SUMMARY)
    expect(out).toContain('What each model reported:')
    expect(out).toContain('groq-llama-3.3-70b-versatile — rate-limit: 413 request too large')
    expect(out).toContain('cerebras-gpt-oss-120b — timeout')
  })

  it("names a legacy step for what it is — the key's default model, not an internal id", () => {
    const out = exhaustionReport(SUMMARY, [
      { catalogId: 'legacy:openai', reason: 'failed: 400 invalid image' }
    ])
    expect(out).toContain("openai (your key's default model) — failed: 400 invalid image")
    expect(out).not.toContain('legacy:')
  })

  it('collapses IDENTICAL reasons into one line — five same failures are one fact', () => {
    const attempts = Array.from({ length: 5 }, (_, i) => ({
      catalogId: `model-${i}`,
      reason: 'failed: 400 context_length_exceeded'
    }))
    const out = exhaustionReport(SUMMARY, attempts)
    expect(out).toContain('All 5 models reported the same thing:')
    expect(out).toContain('400 context_length_exceeded')
    // One line of evidence, not five copies.
    expect(out.split('400 context_length_exceeded')).toHaveLength(2)
  })

  it('caps distinct attempts at five and counts the rest', () => {
    const attempts = Array.from({ length: 8 }, (_, i) => ({
      catalogId: `model-${i}`,
      reason: `reason-${i}`
    }))
    const out = exhaustionReport(SUMMARY, attempts)
    expect(out).toContain('model-4 — reason-4')
    expect(out).not.toContain('model-5')
    expect(out).toContain('…and 3 more')
  })

  it('truncates a runaway provider error body rather than flooding the screen', () => {
    const out = exhaustionReport(SUMMARY, [
      { catalogId: 'm', reason: 'failed: ' + 'x'.repeat(500) }
    ])
    const line = out.split('\n').find((l) => l.startsWith('• '))!
    expect(line.length).toBeLessThan(200)
    expect(line.endsWith('…')).toBe(true)
  })
})

// BUG-125c — the "not tried" half. `attempts` records what RAN; when a chain
// that should hold several models produces ONE attempt, the entire story is in
// what did not run. Two field reports were lost to that gap.
describe('exhaustionReport — models that were never attempted', () => {
  it('names what was skipped and the gate that skipped it', () => {
    const out = exhaustionReport(
      SUMMARY,
      [{ catalogId: 'google-gemini-flash', reason: 'rate-limit: quota' }],
      [
        { catalogId: 'legacy:openai', why: 'cooling down for another 42m' },
        { catalogId: 'legacy:anthropic', why: 'skipped by the usability gate' }
      ]
    )
    expect(out).toContain('What each model reported:')
    expect(out).toContain('Not tried at all:')
    expect(out).toContain("openai (your key's default model) — cooling down for another 42m")
    expect(out).toContain('anthropic')
  })

  it('appears even when NOTHING was attempted — the pre-walk refusal case', () => {
    const out = exhaustionReport(SUMMARY, [], [
      { catalogId: 'google-gemini-flash', why: 'cooling down for another 1h' }
    ])
    expect(out).toContain('Not tried at all:')
    expect(out).toContain('google-gemini-flash — cooling down for another 1h')
  })

  it('is absent when everything was tried — no empty section', () => {
    const out = exhaustionReport(SUMMARY, [{ catalogId: 'm', reason: 'timeout' }], [])
    expect(out).not.toContain('Not tried')
  })
})
