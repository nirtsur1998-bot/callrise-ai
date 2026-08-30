import { describe, it, expect } from 'vitest'
import {
  buildActivationSteps,
  activationProgress,
  type ActivationState,
  type ActivationStep
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
 *
 * And one that arrived later, with evidence behind it: FOUR STEPS, NOT SIX.
 * See the count test below.
 */

const nothing: ActivationState = {
  hasTranscriptionKey: false,
  hasAiKey: false,
  callCount: 0,
  coachedCount: 0,
  salesBrainOn: false
}

const everything: ActivationState = {
  hasTranscriptionKey: true,
  hasAiKey: true,
  callCount: 12,
  coachedCount: 5,
  salesBrainOn: true
}

describe('the list is four steps, and that is a constraint', () => {
  it('has exactly four', () => {
    // docs/M31-design-research.md, round 1: Chameleon's analysis of 15M
    // onboarding interactions puts completion at ~74% for four steps and ~16%
    // at seven-plus. This list was SIX until the research reached the repo —
    // not a decision, an absence of one. The founder cut "Connect your
    // calendar" (unfinishable while BUG-136 blocks Google sign-in — an
    // unfinishable step is worse than an absent one) and "Coach one of your
    // calls" (a good action, but not activation).
    //
    // A fifth step should be an argument, not a commit. That is what this
    // assertion is for.
    expect(buildActivationSteps(nothing)).toHaveLength(4)
  })

  it('keeps the ones without which the product does nothing', () => {
    const ids = buildActivationSteps(nothing).map((s) => s.id)
    expect(ids).toEqual(['transcription-key', 'ai-key', 'first-call', 'sales-brain'])
  })
})

describe('it knows what is already done', () => {
  it('marks nothing done on a blank install', () => {
    const steps = buildActivationSteps(nothing)
    expect(steps.every((s) => s.status === 'todo')).toBe(true)
    expect(activationProgress(steps)).toEqual({ done: 0, total: 4, complete: false })
  })

  it('marks everything done for a fully set-up account', () => {
    const steps = buildActivationSteps(everything)
    expect(steps.every((s) => s.status === 'done')).toBe(true)
    expect(activationProgress(steps).complete).toBe(true)
  })

  it('reflects a PARTIALLY set-up account rather than starting from zero', () => {
    // The specific lie the founder named: unchecked boxes for work already done.
    const partial: ActivationState = {
      ...nothing,
      hasTranscriptionKey: true,
      hasAiKey: true,
      callCount: 3
    }
    const steps = buildActivationSteps(partial)
    expect(Object.fromEntries(steps.map((s) => [s.id, s.status]))).toEqual({
      'transcription-key': 'done',
      'ai-key': 'done',
      'first-call': 'done',
      'sales-brain': 'todo'
    })
    expect(activationProgress(steps)).toEqual({ done: 3, total: 4, complete: false })
  })

  it('counts a single call correctly — no "1 calls"', () => {
    const one = buildActivationSteps({ ...nothing, callCount: 1 })
    expect(one.find((s) => s.id === 'first-call')!.doneLabel).toContain('1 call saved')
    const many = buildActivationSteps({ ...nothing, callCount: 4 })
    expect(many.find((s) => s.id === 'first-call')!.doneLabel).toContain('4 calls saved')
  })
})

describe('a completed step teaches rather than just ticking', () => {
  it('says what you HAVE, not that you did it', () => {
    for (const step of buildActivationSteps(everything)) {
      expect(step.doneLabel.length, `${step.id} has a token doneLabel`).toBeGreaterThan(25)
    }
  })

  it("names what the thing DOES, using the founder's own example", () => {
    const brain = buildActivationSteps(everything).find((s) => s.id === 'sales-brain')!
    expect(brain.doneLabel.toLowerCase()).toContain('learning from your calls')
  })
})

describe('every step answers "why would I bother"', () => {
  it('gives each step a why that describes the OUTCOME', () => {
    for (const step of buildActivationSteps(nothing)) {
      expect(step.why.length, `${step.id} has no real why`).toBeGreaterThan(40)
      expect(step.why.toLowerCase()).not.toBe(step.title.toLowerCase())
    }
  })

  it('gives every step somewhere to go', () => {
    for (const step of buildActivationSteps(nothing)) {
      expect(
        Boolean(step.settingsPage || step.navTo),
        `${step.id} has no settingsPage and no navTo — nowhere to act`
      ).toBe(true)
    }
  })
})

describe('the blocked-step machinery survives the calendar cut', () => {
  // No step produces a blocked status today — the only one that did was the
  // calendar step, cut on 2026-08-30. The MECHANISM is deliberately kept: it
  // is the right shape for any future step that can be unreachable through no
  // fault of the user, and deleting it would mean rebuilding it (and its
  // reasoning) the next time one appears.
  //
  // So it is tested against a hand-built list rather than through
  // buildActivationSteps. That is the honest way to test a rule whose only
  // producer was removed — the alternative is deleting the tests and quietly
  // losing the guarantee.
  const step = (id: string, status: ActivationStep['status']): ActivationStep => ({
    id,
    title: id,
    why: 'x',
    doneLabel: 'y',
    status
  })

  it('does not count a blocked step against the user', () => {
    // Not their failure, so the checklist must not sit at 3/4 forever
    // implying they left something undone.
    const steps = [step('a', 'done'), step('b', 'done'), step('c', 'blocked')]
    expect(activationProgress(steps)).toEqual({ done: 2, total: 2, complete: true })
  })

  it('never reports blocked as done', () => {
    const steps = [step('a', 'blocked'), step('b', 'todo')]
    expect(activationProgress(steps).done).toBe(0)
    expect(activationProgress(steps).complete).toBe(false)
  })
})
