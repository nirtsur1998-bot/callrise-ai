// BUG-259 — the first line is not the title when the model thinks out loud.
//
// `titleFromText` took the FIRST non-empty line and cleaned two prefixes off
// it, assuming a model asked for a title answers with a title. A reasoning
// model answers with its reasoning, so the founder's call list filled with rows
// reading "Here's a thinking process:" and "We need to produce a short specific
// title 5-8 words, compa…". Three are persisted on their disk.
//
// The trailing-punctuation rule stripped "." and never ":", and nothing
// anywhere asked whether the result LOOKED like a title.
import { describe, expect, it } from 'vitest'
import { titleFromText, looksLikeTitle } from '../call-title'

describe('BUG-259 — the exact answers that reached the founder’s call list', () => {
  it('refuses "Here\'s a thinking process:" rather than storing it as a title', () => {
    expect(titleFromText("Here's a thinking process:\n\n1. Read the transcript")).toBe('')
  })

  it('refuses the model narrating the prompt back at itself', () => {
    // Defended THREE ways — 14 words (over the 12 cap), the task vocabulary
    // "5-8 words", and the "we need" opener. The red-check found this by
    // partially firing: disabling the reasoning openers alone left this test
    // green. That is redundant coverage rather than a hollow assertion, so the
    // finding was that my PREDICTION was wrong, not the test. Recorded because
    // "it went partially red and I changed nothing" needs a reason on the page.
    const seen =
      'We need to produce a short specific title 5-8 words, company/person name plus topic.'
    expect(titleFromText(seen)).toBe('')
  })

  it('refuses "We need to read transcript, find company/person name mentioned, then choose"', () => {
    expect(
      titleFromText('We need to read transcript, find company/person name mentioned, then choose')
    ).toBe('')
  })
})

describe('BUG-259 — an empty answer is the POINT, not a gap', () => {
  it('returns "" when the response contains no title at all', () => {
    // The caller then keeps "Call · Sep 9, 2026, 11:03 AM" — honest,
    // regenerable, and it sorts. A wrong title is worse than no title: it is
    // indistinguishable from a real one in the list and it is what the rep
    // searches against. Same rule as BUG-226's meeting match.
    expect(titleFromText("Here's a thinking process:\n\nWe need 5-8 words.")).toBe('')
  })

  it('never returns a candidate it would not itself accept', () => {
    // The guard and the extractor must agree, or the extractor becomes a
    // second, weaker definition of "a title".
    for (const text of [
      "Here's my analysis:",
      'Step 1: identify the participants',
      'The user wants a title of 5-8 words',
      'Okay so the call is about billing and then the rep offers a refund and then'
    ]) {
      const out = titleFromText(text)
      if (out !== '') expect(looksLikeTitle(out)).toBe(true)
    }
  })
})

describe('BUG-259 — it finds the title when there IS one', () => {
  it('takes a labelled title from the END of a reasoning dump', () => {
    // The fix is not "reject reasoning" — it is "stop assuming position".
    // Reasoning models very often think first and answer last.
    const text = `Here's a thinking process:

1. The caller is from Acme.
2. They ask about renewal pricing.

Title: Acme — Renewal Pricing Questions`
    expect(titleFromText(text)).toBe('Acme — Renewal Pricing Questions')
  })

  it('takes the first line that reads like a title when nothing is labelled', () => {
    expect(titleFromText('Let me think.\n\nAcme Co — Renewal Discussion')).toBe(
      'Acme Co — Renewal Discussion'
    )
  })

  it('still handles the plain, well-behaved answer', () => {
    expect(titleFromText('Acme Co — Renewal Discussion')).toBe('Acme Co — Renewal Discussion')
  })

  it('still strips quotes, markdown bold and a "Title:" prefix', () => {
    expect(titleFromText('**Title:** "Acme Co — Renewal Discussion"')).toBe(
      'Acme Co — Renewal Discussion'
    )
  })

  it('prefers the LABELLED line over an earlier line that merely looks like one', () => {
    const text = 'Refund call maybe\n\nTitle: Acme — Renewal Pricing'
    expect(titleFromText(text)).toBe('Acme — Renewal Pricing')
  })
})

describe('BUG-259 — the net measured against real titles, not invented ones', () => {
  it('accepts the shapes the product actually produces', () => {
    // Every one of these is a real title from the founder's machine. Measured
    // 2026-09-10: 192 model-made titles, 3 rejected, all three genuinely bad.
    for (const t of [
      'Kevin — Revolut $500 Transfer to HNO',
      'Jack Thompson — Account Returns and Property Investment',
      'Harvey Contact Info Confirmation Call',
      'Carrie and Thomas document follow-up',
      'Emma — Account Progress and Withdrawal Options',
      // The one FALSE POSITIVE the first version produced. A bare `transcript`
      // was a task word; it cost a real title and caught nothing the reasoning
      // openers missed.
      'Incomplete Audio Message Transcript'
    ]) {
      expect(looksLikeTitle(t)).toBe(true)
    }
  })

  it('rejects the adversarial openings, including ones it was not built from', () => {
    // A pattern net catches every example it was built from, which reads as
    // coverage and is not. These 12 were invented AFTER the net, as pressure.
    for (const t of [
      'Let me analyze this call to find the right title',
      'Analysis: the caller is discussing a refund',
      'Step 1: identify the participants',
      'The user wants a title of 5-8 words',
      'Thinking through the transcript now',
      'I need to find the company name first',
      'Reasoning: no company is named, so describe the topic',
      'Alright, scanning for names',
      'Now, the transcript mentions a delivery issue',
      'Okay so the call is about billing',
      'First, I will summarise what happened on this sales call',
      'So the rep is trying to close a renewal here'
    ]) {
      expect(looksLikeTitle(t)).toBe(false)
    }
  })

  it('rejects a title that ends in a colon — a heading, not a name', () => {
    expect(looksLikeTitle('Summary of the call:')).toBe(false)
  })

  it('rejects an over-long line even when it opens innocently', () => {
    expect(
      looksLikeTitle('Acme and the rep discuss renewal pricing and then move on to the security review timeline')
    ).toBe(false)
  })

  it('rejects an empty or near-empty candidate', () => {
    expect(looksLikeTitle('')).toBe(false)
    expect(looksLikeTitle('ok')).toBe(false)
  })
})
