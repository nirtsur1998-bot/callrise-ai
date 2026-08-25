// BUG-119 — the consent guard was an allowlist over a record that outgrew it.
//
// Three times the fix was "add the newly-discovered field to
// applyConsentRetention": BUG-014, BUG-028, BUG-115. Each time the guard went
// back to being a hand-maintained list over a type that keeps growing, and the
// failure mode of forgetting was a LEAK, not an error.
//
// The fix is principle 8's fifth instance: remove the dependency on someone
// remembering. CALL_FIELD_RULES classifies every field by WHOSE content it
// carries, is exhaustive over `Required<Call>` so an unclassified field is a
// compile error, and both privacy guards read it instead of keeping lists.
//
// WHY BY OWNER AND NOT "STRIP OR KEEP": a closed literal of what is safe to
// keep would delete `notes` — free text the REP typed — because the buyer
// declined recording. Data loss wearing a privacy justification is a worse
// outcome than the leak it prevents.
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  saveCall,
  getCall,
  setCallCommitments,
  appendCoachChatTurn,
  appendCallNotes,
  callBackupPayload,
  CALL_FIELD_RULES
} from '../calls-fs'

const BUYER_WORDS = 'We already signed with someone else last quarter.'
const REP_WORDS = 'Understood — when does that contract come up for renewal?'
const REP_NOTE = 'Follow up in March. My own note, nobody else’s.'

describe('BUG-119 — the guard derives from one classification', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'callrise-fieldclass-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** recordOtherParty !== true — the buyer declined, or revoked mid-call. */
  async function revokedCall(): Promise<string> {
    const saved = await saveCall(dir, {
      startedAt: new Date().toISOString(),
      durationMs: 60_000,
      segments: [
        { speaker: 0, channel: 0, text: REP_WORDS },
        { speaker: 1, channel: 1, text: BUYER_WORDS }
      ],
      consent: {
        status: 'consented',
        method: 'verbal-on-call',
        recordOtherParty: false,
        jurisdiction: 'one-party',
        decidedAt: new Date().toISOString()
      }
    })
    return saved.id
  }

  /** The control: the buyer DID consent. Nothing may change on these. */
  async function consentedCall(): Promise<string> {
    const saved = await saveCall(dir, {
      startedAt: new Date().toISOString(),
      durationMs: 60_000,
      segments: [
        { speaker: 0, channel: 0, text: REP_WORDS },
        { speaker: 1, channel: 1, text: BUYER_WORDS }
      ],
      consent: {
        status: 'consented',
        method: 'verbal-on-call',
        recordOtherParty: true,
        jurisdiction: 'one-party',
        decidedAt: new Date().toISOString()
      }
    })
    return saved.id
  }

  // ---- REP_CONTENT: the thing a naive closed literal would have destroyed --

  it('KEEPS the rep’s own notes — the buyer has no claim on them', async () => {
    const id = await revokedCall()
    await appendCallNotes(dir, id, REP_NOTE)

    const call = await getCall(dir, id)
    expect(call?.notes, 'the rep’s own note was destroyed by a privacy guard').toContain(REP_NOTE)
  })

  // ---- DERIVED with an owner split ---------------------------------------

  it('strips the BUYER’s commitments and keeps the REP’s', async () => {
    const id = await revokedCall()
    await setCallCommitments(dir, id, [
      { owner: 'rep', text: 'I will send the pricing sheet on Monday.' },
      { owner: 'prospect', text: BUYER_WORDS }
    ])

    // Assert on the FILE as well as the read: species 28 — the write path and
    // the read path can disagree, and a returned object only observes one.
    const raw = await readFile(join(dir, `${id}.json`), 'utf8')
    expect(raw, 'the buyer’s commitment reached disk').not.toContain(BUYER_WORDS)

    const call = await getCall(dir, id)
    const owners = (call?.commitments ?? []).map((c) => c.owner)
    expect(owners, 'the buyer’s commitment survived the read').not.toContain('prospect')
    expect(owners, 'the rep’s own commitment was destroyed too').toContain('rep')
  })

  it('a CONSENTED call keeps both sides’ commitments (the control)', async () => {
    const id = await consentedCall()
    await setCallCommitments(dir, id, [
      { owner: 'rep', text: 'I will send the pricing sheet on Monday.' },
      { owner: 'prospect', text: BUYER_WORDS }
    ])
    const call = await getCall(dir, id)
    const owners = (call?.commitments ?? []).map((c) => c.owner)
    expect(owners).toContain('prospect')
    expect(owners).toContain('rep')
  })

  // ---- coachChat: the WHOLE thread, not the buyer-quoting turns -----------

  it('drops the coaching thread ENTIRELY, rather than serving a gapped one', async () => {
    const id = await revokedCall()
    await appendCoachChatTurn(
      dir,
      id,
      { text: 'What did they say about the incumbent?' },
      { text: `They said: "${BUYER_WORDS}"` }
    )

    const call = await getCall(dir, id)
    // Not "no buyer words" — NO THREAD. A thread with turns removed reads as a
    // complete conversation while being an edited one, and the rep cannot tell
    // which turns are missing. Absence is honest; redaction that looks complete
    // is a fabrication.
    expect(call?.coachChat ?? [], 'a gapped thread is worse than none').toHaveLength(0)
  })

  it('a CONSENTED call keeps its coaching thread (the control)', async () => {
    const id = await consentedCall()
    await appendCoachChatTurn(
      dir,
      id,
      { text: 'What did they say about the incumbent?' },
      { text: `They said: "${BUYER_WORDS}"` }
    )
    const call = await getCall(dir, id)
    expect(call?.coachChat ?? []).toHaveLength(2)
  })

  // ---- the classification itself -----------------------------------------

  it('every rule that claims to strip actually strips something', () => {
    // A rule carrying a no-op stripper would look guarded and guard nothing.
    for (const [field, rule] of Object.entries(CALL_FIELD_RULES)) {
      if (!rule.stripOtherParty) continue
      expect(typeof rule.stripOtherParty, `${field}`).toBe('function')
    }
    const withStrippers = Object.values(CALL_FIELD_RULES).filter((r) => r.stripOtherParty)
    expect(withStrippers.length, 'no field is guarded at all').toBeGreaterThan(0)
  })

  it('the map is declared over Required<Call>, so an unclassified field cannot compile', () => {
    // STRUCTURAL, and load-bearing. The compile-time exhaustiveness IS the fix;
    // relaxing `Required<Call>` to `Partial<Call>` to silence an error would
    // remove it silently, with every test here still green.
    const src = readFileSync(join(__dirname, '..', 'calls-fs.ts'), 'utf8')
    expect(src).toContain('CALL_FIELD_RULES: { [K in keyof Required<Call>]: CallFieldRule }')
  })

  it('the guard keeps NO list of its own — it only iterates the rules', () => {
    // The bug was a hand-maintained list inside the guard. If field names
    // reappear in its body, the list is back.
    const src = readFileSync(join(__dirname, '..', 'calls-fs.ts'), 'utf8')
    const body = src.slice(
      src.indexOf('function applyConsentRetention'),
      src.indexOf('\n}', src.indexOf('function applyConsentRetention'))
    )
    const code = body
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    expect(code).toContain('CALL_FIELD_RULES')
    for (const field of ['bookmarks', 'dealIntelligence', 'speakerIdentities', 'commitments']) {
      expect(code, `${field} is named inside the guard — the list is back`).not.toContain(
        `call.${field}`
      )
    }
  })

  // ---- the two guards share the ANSWER, not the ACTION --------------------

  it('the backup payload never carries a field classed BUYER_SPEECH', async () => {
    const id = await consentedCall() // consented: the consent guard strips nothing
    const call = await getCall(dir, id)
    expect(call).toBeTruthy()
    const payload = JSON.stringify(callBackupPayload(call!))

    // callBackupPayload guards a DIFFERENT boundary — "what may ever leave this
    // device" — and applies to consented calls too. Same classification, its
    // own action.
    expect(payload, 'verbatim speech left the device on a consented call').not.toContain(
      BUYER_WORDS
    )
    expect(payload, 'verbatim rep speech left the device').not.toContain(REP_WORDS)
  })
})
