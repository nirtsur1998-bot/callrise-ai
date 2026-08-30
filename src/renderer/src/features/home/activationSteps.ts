import type { SettingsPageId } from '@renderer/features/settings/settings-nav'

/**
 * M31 Stage 3 — the activation checklist.
 *
 * The founder's brief, and each clause changed the design:
 *
 *   1. *"Build it for someone who has nothing set up."* Not a tour of what
 *      exists — a short path from a blank install to the app doing something.
 *   2. *"Make it honest about what each step actually unlocks. Not 'connect
 *      your calendar' but 'connect your calendar so meetings show up with prep
 *      briefs.' Every step should answer 'why would I bother.'"*
 *   3. *"It should know what's already done. A checklist that shows me four
 *      completed items and one remaining is useful; one that shows five
 *      unchecked boxes when I've done four is the same lie as the empty states
 *      we just spent a week fixing."*
 *   4. *"When a step is already done, say so in a way that TEACHES. 'Sales
 *      Brain — on' is a tick. 'Sales Brain — on, learning from your calls'
 *      tells me what I've got."* — hence `doneLabel`, which is not decoration:
 *      half the 50%-invisible problem was not knowing what the things already
 *      switched on actually do.
 *   5. A step that CANNOT be completed for a reason outside the user's control
 *      says so instead of offering an action that cannot succeed — the same
 *      prerequisite rule the empty states use, where "nothing to identify on
 *      this call" gets an explanation and no button.
 *
 * This module is the pure part: the step definitions and the resolution from
 * app state to status. Kept separate from the card that renders it for the
 * reason BUG-140 forced — component render output cannot be tested in this
 * repo, so everything with a rule in it lives where a test can reach it.
 */

/** Everything the checklist needs to decide what is done. Deliberately a
 *  plain snapshot rather than the live APIs: it makes every branch reachable
 *  from a test without mocking eight IPC channels. */
export interface ActivationState {
  /** DEEPGRAM_API_KEY configured — live transcription works at all. */
  hasTranscriptionKey: boolean
  /** Any text-AI provider key configured — summaries, coaching, everything. */
  hasAiKey: boolean
  /** Saved calls on disk. */
  callCount: number
  /** Calls that have been coached. */
  coachedCount: number
  /* calendarConnected / calendarBlockedReason were removed when the
     calendar step was cut (2026-08-30). The blocked MACHINERY below is
     deliberately kept — ActivationStep.blockedReason, and
     activationProgress excluding blocked from both halves of the ratio —
     because it is the right shape for any future step that can be
     unreachable, and it is still tested. Re-adding the calendar step means
     re-adding these two fields AND the google/outlook fetches in
     ActivationChecklist that fed them. */
  /** Sales Brain on — the thing that makes every other AI feature sharper. */
  salesBrainOn: boolean
  // (see the note above — both calendar fields were removed together)
}

export type ActivationStatus = 'done' | 'todo' | 'blocked'

export interface ActivationStep {
  id: string
  /** The action, as an instruction. */
  title: string
  /** WHY it is worth doing — what it unlocks, in the user's terms. Required:
   *  a step that cannot say why is a step nobody has a reason to complete. */
  why: string
  /** Shown INSTEAD of `why` once done — what you now have, not just a tick. */
  doneLabel: string
  /** Where the action happens. */
  settingsPage?: SettingsPageId
  /** For steps whose action is not in Settings (record a call, coach a call). */
  navTo?: 'live-calls' | 'past-calls'
  status: ActivationStatus
  /** Only when status is 'blocked' — why, in plain terms. */
  blockedReason?: string
}

/**
 * The steps, in the order someone with nothing set up should do them.
 *
 * Deliberately FOUR. Two constraints, and the second one has numbers behind
 * it:
 *
 *   1. Not the full feature list. The audit found ~40 stranded features; a
 *      checklist of forty is a second discoverability problem. These are the
 *      ones without which the product does nothing at all, plus the one
 *      (Sales Brain) that changes the quality of everything after it.
 *   2. FOUR IS THE CEILING, not a coincidence. docs/M31-design-research.md
 *      records Chameleon data across 15M onboarding interactions:
 *      completion runs ~74% at four steps and collapses to ~16% at seven
 *      plus. This list was six before the research reached the repo.
 *      activationSteps.test.ts asserts the count, so a fifth step has to be
 *      an argument rather than a commit.
 */
export function buildActivationSteps(state: ActivationState): ActivationStep[] {
  const steps: ActivationStep[] = [
    {
      id: 'transcription-key',
      title: 'Add a transcription key',
      why: 'Without it nothing is written down — CallRise can hear your calls but cannot turn them into text. Deepgram is free to start and takes about a minute.',
      doneLabel: 'Added — your calls are transcribed live, word by word, as you speak.',
      settingsPage: 'ai-setup',
      status: state.hasTranscriptionKey ? 'done' : 'todo'
    },
    {
      id: 'ai-key',
      title: 'Add an AI provider key',
      why: 'Turns transcripts into things you can use: call summaries, coaching scores, extracted tasks, prep briefs. Several providers have free tiers.',
      doneLabel: 'Added — summaries, coaching and task extraction can all run.',
      settingsPage: 'ai-setup',
      status: state.hasAiKey ? 'done' : 'todo'
    },
    {
      id: 'first-call',
      title: 'Record your first call',
      why: 'Everything else works from a real call. Start one from Calls — you can talk to yourself for thirty seconds to see the whole thing work end to end.',
      doneLabel:
        state.callCount === 1
          ? 'Done — 1 call saved, with its transcript.'
          : `Done — ${state.callCount} calls saved, with transcripts.`,
      navTo: 'live-calls',
      status: state.callCount > 0 ? 'done' : 'todo'
    },
    // TWO STEPS WERE CUT HERE (2026-08-30), and the reason is evidence, not
    // taste. docs/M31-design-research.md records Chameleon data on 15M
    // onboarding interactions: completion runs ~74% at four steps and falls
    // to ~16% at seven-plus. This list had SIX, which was not a decision —
    // it was written before the research was in the repo. Founder cut it to
    // four once the numbers were on the table.
    //
    // "Connect your calendar" — an unfinishable step is worse than an absent
    // one, and it is unfinishable while BUG-136 has Google sign-in broken.
    // That was the founder's own rule about blocked steps, applied to their
    // own checklist. If calendar becomes connectable, it can be argued back
    // in — the blocked-state machinery below still works and is still tested.
    //
    // "Coach one of your calls" — a good action, but not ACTIVATION. Someone
    // already set up will find it; someone who is not is not ready for it.
    // Activation is the shortest path to the product doing something at all.
    {
      id: 'sales-brain',
      title: 'Let it learn from your calls',
      why: 'Sales Brain remembers who you are, how you sell, and each client — so summaries and coaching stop starting from scratch every time. Runs entirely on your own device.',
      doneLabel:
        'On — learning from your calls, and every AI feature gets sharper as it does.',
      settingsPage: 'sales-brain',
      status: state.salesBrainOn ? 'done' : 'todo'
    }
  ]
  return steps
}

/** How many are genuinely done — blocked does NOT count as done. Telling
 *  someone they are finished when a step is unreachable is the same lie the
 *  empty states were fixed for. */
export function activationProgress(steps: ActivationStep[]): {
  done: number
  total: number
  complete: boolean
} {
  const done = steps.filter((s) => s.status === 'done').length
  // Blocked steps are excluded from the denominator too: it is not the user's
  // failure that Google sign-in is down, and a checklist stuck at 5/6 through
  // no fault of theirs reads as nagging.
  const total = steps.filter((s) => s.status !== 'blocked').length
  return { done, total, complete: done >= total }
}
