// BUG-163, the siblings the sweep found. Same defect, different fields:
// a tool-schema field listed in `required` while the model is told it may
// leave it empty. These two are lower-severity than buyerName (nothing here
// writes to the CRM), but clientName is rendered as a task's subtitle on the
// rep's calendar, so a model answering "N/A" puts that word in front of them.
import { describe, expect, it } from 'vitest'
import { verifyDetectedName } from '../contact-intelligence'
import type { CallSegment } from '../calls-fs'

describe('BUG-163 siblings — verifyDetectedName', () => {
  // A transcript that genuinely contains the word, so the grounding checks
  // pass and the placeholder check is the ONLY thing that can reject it.
  // Without this the test would pass on the grounding alone and prove nothing.
  const segments: CallSegment[] = [
    {
      speaker: 1,
      channel: 1,
      text: 'the report came back null and we could not read the field at all',
      startMs: 0
    } as CallSegment
  ]

  it('rejects "null" even when the quote genuinely grounds it', () => {
    expect(
      verifyDetectedName(
        'null',
        'the report came back null and we could not read the field at all',
        segments
      )
    ).toBeNull()
  })

  it('CONTROL — the same grounding accepts a real name', () => {
    const real: CallSegment[] = [
      {
        speaker: 1,
        channel: 1,
        text: 'hi there this is Sarah calling from Acme about the renewal',
        startMs: 0
      } as CallSegment
    ]
    expect(
      verifyDetectedName('Sarah', 'hi there this is Sarah calling from Acme about the renewal', real)
    ).toBe('Sarah')
  })
})

describe('BUG-163 siblings — generate-tasks clientName/note', () => {
  // parseTask isn't exported; assert the helper both fields now route
  // through, which is the whole of the change.
  it('reads every placeholder spelling as absence', async () => {
    const { modelStringOrNull } = await import('../ai/model-placeholders')
    for (const p of ['null', 'N/A', 'none', 'unknown', 'not specified', '-', '  ', '"null"']) {
      expect(modelStringOrNull(p, 200)).toBeNull()
    }
  })

  it('CONTROL — keeps a real client name, including ones containing a placeholder word', () => {
    return import('../ai/model-placeholders').then(({ modelStringOrNull }) => {
      expect(modelStringOrNull('Acme Corp', 200)).toBe('Acme Corp')
      expect(modelStringOrNull('Nunes Holdings', 200)).toBe('Nunes Holdings')
      expect(modelStringOrNull('Noneli Adeyemi', 200)).toBe('Noneli Adeyemi')
    })
  })
})
