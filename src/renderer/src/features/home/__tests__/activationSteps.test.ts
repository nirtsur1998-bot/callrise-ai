import { describe, it, expect } from 'vitest'
import {
  buildActivationSteps,
  activationProgress,
  type ActivationState
} from '../activationSteps'

/**
 * M31 Stage 3 — the activation checklist.
 *
 * Three of the founder's clauses are requirements rather than preferences, so
 * each gets a test:
 *
 *   • it KNOWS WHAT IS DONE — "one that shows five unchecked boxes when I've
 *     done four is the same lie as the empty states we just spent a week
 *     fixing"
 *   • a done step TEACHES — "'Sales Brain — on' is a tick. 'Sales Brain — on,
 *     learning from your calls' tells me what I've got"
 *   • every step answers "why would I bother"
 */

const nothing: ActivationState = {
  hasTranscriptionKey: false,
  hasAiKey: false,
  callCount: 0,
  coachedCount: 0,
  calendarConnected: false,
  salesBrainOn: false,
  calendarBlockedReason: null
}

const everything: ActivationState = {
  hasTranscriptionKey: true,
  hasAiKey: true,
  callCount: 12,
  coachedCount: 5,
  calendarConnected: true,
  salesBrainOn: true,
  calendarBlockedReason: null
}

describe('it knows what is already done', () => {
  it('marks nothing done on a blank install', () => {
    const steps = buildActivationSteps(nothing)
    expect(steps.every((s) => s.status === 'todo')).toBe(true)
    expect(activationProgress(steps)).toEqual({ done: 0, total: 6, complete: false })
  })

  it('marks everything done for a fully set-up account', () => {
    const steps = buildActivationSteps(everything)
    expect(steps.every((s) => s.status === 'done')).toBe(true)
    expect(activationProgress(steps).complete).toBe(true)
  })

  it('reflects a PARTIALLY set-up account rather than starting from zero', () => {
    // The specific lie the founder named: five unchecked boxes when four are
    // done. Each flag independently flips exactly one step.
    const partial: ActivationState = {
      ...nothing,
      hasTranscriptionKey: true,
      hasAiKey: true,
      callCount: 3,
      salesBrainOn: true
    }
    const steps = buildActivationSteps(partial)
    const byId = Object.fromEntries(steps.map((s) => [s.id, s.status]))
    expect(byId).toEqual({
      'transcription-key': 'done',
      'ai-key': 'done',
      'first-call': 'done',
      'first-coach': 'todo',
      calendar: 'todo',
      'sales-brain': 'done'
    })
    expect(activationProgress(steps)).toEqual({ done: 4, total: 6, complete: false })
  })

  it('counts a single call correctly — no "1 calls"', () => {
    const one = buildActivationSteps({ ...nothing, callCount: 1, coachedCount: 1 })
    expect(one.find((s) => s.id === 'first-call')!.doneLabel).toContain('1 call saved')
    expect(one.find((s) => s.id === 'first-coach')!.doneLabel).toContain('1 call has a scorecard')
    const many = buildActivationSteps({ ...nothing, callCount: 4, coachedCount: 2 })
    expect(many.find((s) => s.id === 'first-call')!.doneLabel).toContain('4 calls saved')
  })
})

describe('a completed step teaches rather than just ticking', () => {
  it('says what you HAVE, not that you did it', () => {
    for (const step of buildActivationSteps(everything)) {
      // Long enough to be a sentence about the feature, not a checkmark's
      // worth of text. "Done" and "On" alone would pass a length check of 2.
      expect(step.doneLabel.length, `${step.id} has a token doneLabel`).toBeGreaterThan(25)
    }
  })

  it("names what the thing DOES, using the founder's own example", () => {
    const brain = buildActivationSteps(everything).find((s) => s.id === 'sales-brain')!
    // "'Sales Brain — on' is a tick. 'Sales Brain — on, learning from your
    // calls' tells me what I've got."
    expect(brain.doneLabel.toLowerCase()).toContain('learning from your calls')
  })
})

describe('every step answers "why would I bother"', () => {
  it('gives each step a why that describes the OUTCOME', () => {
    for (const step of buildActivationSteps(nothing)) {
      expect(step.why.length, `${step.id} has no real why`).toBeGreaterThan(40)
      // A why that just restates the title is not a why.
      expect(step.why.toLowerCase()).not.toBe(step.title.toLowerCase())
    }
  })

  it('the calendar step names prep briefs, not "connect your calendar"', () => {
    // The founder's literal example of the difference.
    const cal = buildActivationSteps(nothing).find((s) => s.id === 'calendar')!
    expect(cal.why.toLowerCase()).toContain('prep brief')
  })

  it('gives every step somewhere to go', () => {
    // A step with no destination is the dead end this whole stage removed.
    for (const step of buildActivationSteps(nothing)) {
      expect(
        Boolean(step.settingsPage || step.navTo),
        `${step.id} has no settingsPage and no navTo — nowhere to act`
      ).toBe(true)
    }
  })
})

describe('a step that cannot be completed says so', () => {
  const blocked: ActivationState = {
    ...nothing,
    calendarBlockedReason: 'Google sign-in is currently unavailable.'
  }

  it('marks it blocked rather than todo', () => {
    const cal = buildActivationSteps(blocked).find((s) => s.id === 'calendar')!
    expect(cal.status).toBe('blocked')
    expect(cal.blockedReason).toContain('Google sign-in')
  })

  it('does not count a blocked step against the user', () => {
    // Not their failure, so the checklist must not sit at 5/6 forever
    // implying they left something undone.
    const steps = buildActivationSteps({
      ...blocked,
      hasTranscriptionKey: true,
      hasAiKey: true,
      callCount: 1,
      coachedCount: 1,
      salesBrainOn: true
    })
    expect(activationProgress(steps)).toEqual({ done: 5, total: 5, complete: true })
  })

  it('never reports blocked as done', () => {
    // The opposite error: pretending an unreachable step is finished.
    const steps = buildActivationSteps(blocked)
    expect(steps.find((s) => s.id === 'calendar')!.status).not.toBe('done')
    expect(activationProgress(steps).done).toBe(0)
  })

  it('drops the blocked state the moment the step is actually satisfied', () => {
    // A connected calendar beats a blocked-reason: if it is already working,
    // an outage notice about connecting it is noise.
    const cal = buildActivationSteps({ ...blocked, calendarConnected: true }).find(
      (s) => s.id === 'calendar'
    )!
    expect(cal.status).toBe('done')
    expect(cal.blockedReason).toBeUndefined()
  })
})
