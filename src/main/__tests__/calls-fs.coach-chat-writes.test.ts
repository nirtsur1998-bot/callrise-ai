// M23 Workstream B review fixes — regression coverage for the two
// read-modify-write helpers coaching chat relies on to avoid losing data
// under concurrent single-item writes (see appendCommitment's doc comment
// in calls-fs.ts for why setCallCommitments() alone isn't safe for this).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveCall, getCall, appendCommitment, appendCoachChatTurn } from '../calls-fs'

describe('appendCommitment', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'callrise-calls-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function makeCall(): Promise<string> {
    const summary = await saveCall(dir, {
      startedAt: new Date().toISOString(),
      durationMs: 60_000,
      segments: [{ speaker: 0, text: 'Lets lock next steps.' }],
      consent: { status: 'consented', jurisdiction: 'two-party', recordOtherParty: true }
    })
    return summary.id
  }

  it('adds a commitment to a call that has none yet', async () => {
    const callId = await makeCall()
    const updated = await appendCommitment(dir, callId, { owner: 'rep', text: 'Send pricing sheet' })
    expect(updated?.commitments).toEqual([{ owner: 'rep', text: 'Send pricing sheet' }])
  })

  it('merges onto an existing commitment instead of overwriting it', async () => {
    const callId = await makeCall()
    await appendCommitment(dir, callId, { owner: 'rep', text: 'Send pricing sheet' })
    const updated = await appendCommitment(dir, callId, { owner: 'prospect', text: 'Loop in procurement' })
    expect(updated?.commitments).toEqual([
      { owner: 'rep', text: 'Send pricing sheet' },
      { owner: 'prospect', text: 'Loop in procurement' }
    ])
    const reread = await getCall(dir, callId)
    expect(reread?.commitments).toHaveLength(2)
  })

  // The exact race the fix targets: two suggestion chips clicked back to
  // back, both reading "current commitments" before either write lands.
  // appendCommitment's read-modify-write happens INSIDE the per-call lock,
  // so firing both concurrently must still keep both, not lose one to a
  // last-write-wins overwrite.
  it('keeps both commitments when two appends race concurrently', async () => {
    const callId = await makeCall()
    await Promise.all([
      appendCommitment(dir, callId, { owner: 'rep', text: 'First promise' }),
      appendCommitment(dir, callId, { owner: 'rep', text: 'Second promise' })
    ])
    const reread = await getCall(dir, callId)
    const texts = (reread?.commitments ?? []).map((c) => c.text).sort()
    expect(texts).toEqual(['First promise', 'Second promise'])
  })
})

describe('appendCoachChatTurn — end-practice role alternation', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'callrise-calls-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function makeCall(): Promise<string> {
    const summary = await saveCall(dir, {
      startedAt: new Date().toISOString(),
      durationMs: 60_000,
      segments: [{ speaker: 0, text: 'Pretend I am the buyer.' }],
      consent: { status: 'consented', jurisdiction: 'two-party', recordOtherParty: true }
    })
    return summary.id
  }

  // Regression test for the critical bug the review found: tagging the
  // "end practice" user turn as 'advisor' (matching the coaching-feedback
  // reply it triggers), not 'practice' (its literal trigger mode) — so that
  // filtering the thread down to advisor-only turns for later requests
  // never produces two consecutive assistant-role messages with no user
  // turn between them, which providers reject as an invalid sequence.
  it('keeps user/assistant strictly alternating in the advisor-only view across an end-practice exchange', async () => {
    const callId = await makeCall()
    await appendCoachChatTurn(
      dir,
      callId,
      { text: 'Hi, tell me about your budget.', mode: 'practice' },
      { text: "We're still figuring that out.", mode: 'practice' }
    )
    // The end-practice pair: both tagged 'advisor', per the fix.
    await appendCoachChatTurn(
      dir,
      callId,
      { text: 'end practice', mode: 'advisor' },
      { text: 'Nice work staying curious about budget.', mode: 'advisor' }
    )
    // A later real advisor question.
    await appendCoachChatTurn(
      dir,
      callId,
      { text: 'What should I ask next time?', mode: 'advisor' },
      { text: 'Try asking about their timeline.', mode: 'advisor' }
    )

    const call = await getCall(dir, callId)
    const advisorOnly = (call?.coachChat ?? []).filter((m) => m.mode !== 'practice')

    expect(advisorOnly.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })
})
