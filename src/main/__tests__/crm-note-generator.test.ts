import { describe, expect, it } from 'vitest'
import { crmNoteSourceFromCall } from '../crm-note-generator'
import type { Call, CallSegment } from '../calls-fs'

const segments: CallSegment[] = [
  { speaker: 0, text: 'So tell me about your process', role: 'rep' },
  { speaker: 1, text: 'We use a spreadsheet honestly', role: 'other' }
]

function baseCall(overrides: Partial<Call> = {}): Call {
  return {
    id: 'call-1',
    title: 'Discovery call',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 600_000,
    speakerCount: 2,
    preview: 'preview',
    segments,
    ...overrides
  } as Call
}

describe('crmNoteSourceFromCall', () => {
  it('falls back to the transcript when there is no summary or notes', () => {
    const source = crmNoteSourceFromCall(baseCall())
    expect(source).toContain('We use a spreadsheet honestly')
  })

  it('prefers the executive summary + saved notes over the raw transcript when both exist', () => {
    const call = baseCall({
      summary: {
        executive: 'Discussed pricing and next steps.',
        keyPoints: [],
        actionItems: [],
        questions: [],
        model: 'test',
        createdAt: '2026-01-01T00:00:00.000Z'
      },
      notes: 'CFO is the real decision maker.'
    })
    const source = crmNoteSourceFromCall(call)
    expect(source).toContain('Discussed pricing and next steps.')
    expect(source).toContain('CFO is the real decision maker.')
    expect(source).not.toContain('We use a spreadsheet honestly')
  })

  // Regression coverage for a review finding: keyPoints used to be dropped
  // entirely, producing a materially thinner source than the pre-existing
  // auto-generate path (calls.ts's maybeGenerateCrmNote), which always
  // includes them when the executive summary is non-empty.
  it('includes summary.keyPoints alongside the executive summary, matching maybeGenerateCrmNote', () => {
    const call = baseCall({
      summary: {
        executive: 'Terse summary.',
        keyPoints: ['Budget is tight until Q3', 'Legal review required before signing'],
        actionItems: [],
        questions: [],
        model: 'test',
        createdAt: '2026-01-01T00:00:00.000Z'
      }
    })
    const source = crmNoteSourceFromCall(call)
    expect(source).toContain('Budget is tight until Q3')
    expect(source).toContain('Legal review required before signing')
  })

  it('excludes gap-marker segments from the transcript fallback, like every other AI prompt builder', () => {
    const call = baseCall({
      segments: [
        { speaker: 0, text: 'real speech', role: 'rep' },
        { speaker: 1, text: '', role: 'other', kind: 'gap' }
      ]
    })
    const source = crmNoteSourceFromCall(call)
    expect(source).toContain('real speech')
    expect(source.match(/Speaker/g)?.length).toBe(1)
  })

  it('never includes coachChat turns — this generator runs with no open chat session', () => {
    const call = baseCall({
      summary: {
        executive: 'Summary text.',
        keyPoints: [],
        actionItems: [],
        questions: [],
        model: 'test',
        createdAt: '2026-01-01T00:00:00.000Z'
      },
      coachChat: [
        { id: '1', role: 'user', text: 'a chat question that should not leak in', createdAt: '2026-01-01T00:00:00.000Z' }
      ]
    })
    const source = crmNoteSourceFromCall(call)
    expect(source).not.toContain('a chat question that should not leak in')
  })
})
