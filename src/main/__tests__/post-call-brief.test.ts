import { describe, expect, it, vi } from 'vitest'

// The module reaches for Electron's clipboard at import time; the formatter
// under test does not, so a minimal stub is enough.
vi.mock('electron', () => ({ clipboard: { writeText: () => undefined } }))

const { formatBriefForClipboard, buildTranscriptText } = await import('../post-call-brief')

const BRIEF = {
  brief: 'Acme are evaluating two vendors and want a security review before signing.',
  nextSteps: ['Send the SOC 2 report', 'Book the technical deep-dive for Thursday'],
  email: {
    subject: 'SOC 2 report + Thursday deep-dive',
    body: 'Hi Dana,\n\nThanks for the time today.\n\n— Sam'
  },
  model: 'test-model',
  createdAt: '2026-07-28T00:00:00.000Z'
}

describe('formatBriefForClipboard', () => {
  it('includes the brief, the steps and the whole email', () => {
    const text = formatBriefForClipboard(BRIEF, 'Acme discovery')
    expect(text).toContain('Acme discovery — post-call brief')
    expect(text).toContain(BRIEF.brief)
    expect(text).toContain('- Send the SOC 2 report')
    expect(text).toContain('Subject: SOC 2 report + Thursday deep-dive')
    expect(text).toContain('Hi Dana,')
    expect(text).toContain('— Sam')
  })

  // The rep's usual move is to paste the lot into their mail client and delete
  // everything above the email. That is a two-second edit only if the email is
  // the tail — leading with it would mean deleting from the middle instead.
  it('puts the email last, after a separator', () => {
    const text = formatBriefForClipboard(BRIEF)
    expect(text.indexOf('Subject:')).toBeGreaterThan(text.indexOf(BRIEF.brief))
    expect(text.indexOf('---')).toBeLessThan(text.indexOf('Subject:'))
    expect(text.trimEnd().endsWith('— Sam')).toBe(true)
  })

  it('falls back to a generic heading with no call title', () => {
    expect(formatBriefForClipboard(BRIEF)).toContain('Post-call brief')
  })

  it('omits the NEXT STEPS heading entirely when there are none', () => {
    const text = formatBriefForClipboard({ ...BRIEF, nextSteps: [] })
    expect(text).not.toContain('NEXT STEPS')
    expect(text).toContain('Subject:')
  })

  it('preserves the email body’s own line breaks', () => {
    const text = formatBriefForClipboard(BRIEF)
    expect(text).toContain('Hi Dana,\n\nThanks for the time today.')
  })
})

describe('buildTranscriptText', () => {
  it('labels speakers from 1, not 0', () => {
    const text = buildTranscriptText([
      { speaker: 0, text: 'Hello.' },
      { speaker: 1, text: 'Hi there.' }
    ])
    expect(text).toBe('Speaker 1: Hello.\nSpeaker 2: Hi there.')
  })

  it('is empty for an empty transcript', () => {
    expect(buildTranscriptText([])).toBe('')
  })
})
