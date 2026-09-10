// @vitest-environment node
//
// M39 — the SECOND way a model declines to name someone.
//
// BUG-163 taught this project that a model saying "null" becomes a person
// called null, and built `isAbsenceAnswer` to stop it. That guard is placed
// correctly — `setSpeakerIdentity` calls it, and its comment rightly claims
// "every automatic writer lands here". It still let seven identities through
// named literally **"someone"**, on seven different calls, on the founder's
// real profile.
//
// The reason is the sentence, not the placement. `isAbsenceAnswer` asks "is the
// model saying NOTHING". "someone" says *a person, and I could not tell you
// which* — which is a different claim, and a name field is the only kind of
// field where it is worthless.
//
// SPECIES 86 governs everything below: a word list catches every example it was
// built from, which reads as coverage. So the tests are split in two — the
// cases the list was written for, and the cases it was NOT, including the real
// names it must never eat. The measured escape rate against the founder's
// corpus lives in scripts/verification/m39-nonname-escape-rate.ts: 0 of 7
// caught before, 7 of 7 after, 0 of 29 real names eaten. That is one distinct
// escape, so it proves the fix on the real case and says NOTHING about unseen
// phrasings — that rate is unknown, not zero.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAbsenceAnswer, isNonName } from '../ai/model-placeholders'
import { getCall, setSpeakerIdentity } from '../calls-fs'

describe('M39 — isNonName catches what isAbsenceAnswer cannot', () => {
  it('rejects "someone" — the one that actually happened, seven times', () => {
    expect(isAbsenceAnswer('someone')).toBe(false) // the gap, pinned
    expect(isNonName('someone')).toBe(true)
  })

  it('still rejects everything isAbsenceAnswer rejected', () => {
    // Widening must not narrow. BUG-163's whole vocabulary has to survive.
    for (const w of ['null', 'none', 'unknown', 'n/a', 'no name', 'not specified', '', '  ', '-']) {
      expect(isNonName(w)).toBe(true)
    }
    expect(isNonName(null)).toBe(true)
    expect(isNonName(undefined)).toBe(true)
    expect(isNonName(42)).toBe(true)
  })

  it('rejects the ROLE when the model answers with the slot instead of the filler', () => {
    for (const w of ['the client', 'buyer', 'the customer', 'caller', 'prospect', 'attendee']) {
      expect(isNonName(w)).toBe(true)
    }
  })

  it('strips articles, so one entry covers three phrasings it never saw', () => {
    // The structural half of the fix. "buyer" is listed once; "the buyer",
    // "a buyer" and "this buyer" come free, which is what makes the list a
    // CATEGORY rather than a record of sightings.
    for (const w of ['a participant', 'the participant', 'this participant', 'participant']) {
      expect(isNonName(w)).toBe(true)
    }
  })

  it('rejects a diarizer label handed back as a name', () => {
    for (const w of ['speaker 1', 'Speaker 0', 'spk2', 'channel 1', 'participant 3']) {
      expect(isNonName(w)).toBe(true)
    }
  })

  it('sees through quoting and trailing punctuation', () => {
    for (const w of ['"someone"', '(someone)', 'someone.', 'Someone!', '  SOMEONE  ']) {
      expect(isNonName(w)).toBe(true)
    }
  })
})

describe('M39 — and eats no real people, which is the half that costs more', () => {
  it('accepts every real name from the founder\'s measured corpus', () => {
    // The 29 distinct REAL names found across 47 self-introductions on the
    // real profile. A guard that strips one of these deletes a person, and a
    // deletion is invisible in a way a bad name is not.
    const real = [
      'Andre', 'Anshur', 'Belinda', 'Brett', 'Cheryl', 'Daniel', 'Dean', 'Diane',
      'Elaine', 'Emma', 'Harvey', 'Jack', 'Jamie', 'John', 'Kamal', 'Kevin',
      'Kevin Mooney', 'Laurence', 'Lawrence', 'Maria', 'Paul Trader', 'Philip',
      'Philip Collins', 'Rachel', 'Rachel Bremner', 'Stuart', 'Thomas', 'Tracy',
      'Valentin'
    ]
    expect(real.length).toBe(29)
    for (const name of real) expect(isNonName(name)).toBe(false)
  })

  it('keeps BUG-163\'s own survivors — a name CONTAINING a placeholder word', () => {
    for (const name of ['Nunes', 'Noneli Adeyemi', 'Anna Nullman']) {
      expect(isNonName(name)).toBe(false)
    }
  })

  it('keeps real names that are also common words', () => {
    // The deliberate omissions. "Guy" is a real first name; stripping it to
    // catch a rare placeholder trades a certain loss for an uncertain gain.
    // Written down as a test so the next person to widen the list sees the
    // decision rather than rediscovering it.
    for (const name of ['Guy', 'Grant', 'Bill', 'Mark', 'Will', 'Rich', 'Sue', 'Art']) {
      expect(isNonName(name)).toBe(false)
    }
  })

  it('keeps a name that merely STARTS with a listed word', () => {
    // Whole-string matching, never a prefix — "Leadbetter" is not "lead".
    for (const name of ['Leadbetter', 'Agentha', 'Userman', 'Clientele Brown']) {
      expect(isNonName(name)).toBe(false)
    }
  })

  it('keeps a two-word name whose FIRST word is listed', () => {
    // "Someone Else" is unlikely, but "Guy Ritchie" is not, and whole-string
    // matching is what separates them from a prefix check.
    expect(isNonName('Guy Ritchie')).toBe(false)
    expect(isNonName('Grant Client')).toBe(false)
  })

  it('does NOT widen the global absence vocabulary', () => {
    // isNonName is for name fields only. Every other free-text field in the app
    // calls isAbsenceAnswer, and "someone" is a perfectly good answer to a
    // question that is not "who is this" — widening the global list to fix a
    // name field would silently change fields nobody looked at.
    expect(isAbsenceAnswer('someone')).toBe(false)
    expect(isAbsenceAnswer('the client')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// THE WIRING. Everything above tests the FUNCTION, and every one of those tests
// stays green if someone reverts the two call sites to `isAbsenceAnswer` — the
// guard would be perfect and unreachable, which is the shape this project keeps
// finding (a field proven written while absent on 196 of 196 records; a linter
// installed but never in the gate). So the two places that decide whether a
// model's answer becomes a person are exercised here against a real directory.
// ---------------------------------------------------------------------------
describe('M39 — and the guard is actually WIRED IN, not merely correct', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'callrise-nonname-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const seed = async (id: string, identityName?: string): Promise<void> => {
    const call: Record<string, unknown> = {
      id,
      title: 'A call',
      createdAt: '2026-09-10T10:00:00.000Z',
      updatedAt: '2026-09-10T10:00:00.000Z',
      durationMs: 60_000,
      segments: [{ speaker: 1, text: 'Hello there.' }]
    }
    if (identityName) {
      call.speakerIdentities = {
        'mono/spk1': {
          name: identityName,
          source: 'self-intro',
          confidence: 'medium',
          resolvedAt: '2026-09-10T10:00:00.000Z'
        }
      }
    }
    await writeFile(join(dir, `${id}.json`), JSON.stringify(call), 'utf8')
  }

  it('the WRITE gate refuses "someone" but accepts a real name — read from DISK', async () => {
    // setSpeakerIdentity calls itself "the LAST gate before a model's answer
    // becomes a person", and every automatic writer lands on it.
    //
    // ASSERTED AGAINST THE RAW FILE, not through `getCall`. The first version
    // of this test used getCall and its red-check came back GREEN: with the
    // write gate reverted on purpose, the READ guard stripped the same record
    // on the way out and the observable end state was identical. Two guards,
    // one assertion, and no way to tell which one was working — the break was
    // real and simply unreachable by what the test looked at.
    await seed('w1')
    await setSpeakerIdentity(dir, 'w1', 'mono/spk1', {
      name: 'someone',
      source: 'self-intro',
      confidence: 'medium'
    })
    const raw = JSON.parse(await readFile(join(dir, 'w1.json'), 'utf8'))
    expect(raw.speakerIdentities ?? {}).toEqual({})

    await setSpeakerIdentity(dir, 'w1', 'mono/spk1', {
      name: 'Sarah Chen',
      source: 'self-intro',
      confidence: 'medium'
    })
    const raw2 = JSON.parse(await readFile(join(dir, 'w1.json'), 'utf8'))
    expect(raw2.speakerIdentities?.['mono/spk1']?.name).toBe('Sarah Chen')
  })

  it('a name the REP typed is never second-guessed, even a strange one', async () => {
    // 'manual' is exempt by design: the rep is ground truth. Someone really
    // could be filed under a nickname the guard would otherwise refuse.
    await seed('w2')
    await setSpeakerIdentity(dir, 'w2', 'mono/spk1', {
      name: 'someone',
      source: 'manual',
      confidence: 'high'
    })
    expect((await getCall(dir, 'w2'))?.speakerIdentities?.['mono/spk1']?.name).toBe('someone')
  })

  it('the READ path cleans records already on disk — no migration', async () => {
    // The 7 identities named "someone" on the founder's real profile were
    // written before the gate widened. They are cleaned by being read, which
    // is what the read guard's own doc comment promises and had never had to
    // demonstrate.
    await seed('r1', 'someone')
    await seed('r2', 'Sarah Chen')
    expect((await getCall(dir, 'r1'))?.speakerIdentities ?? {}).toEqual({})
    // The control, in the same shape and the same directory: without it, an
    // empty map is equally consistent with "cleaned" and "never parsed".
    expect((await getCall(dir, 'r2'))?.speakerIdentities?.['mono/spk1']?.name).toBe('Sarah Chen')
  })
})
