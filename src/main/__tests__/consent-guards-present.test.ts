// EVERY CONSENT GUARD IN THE CODEBASE, PINNED BY NAME.
//
// WHY THIS FILE EXISTS, and why it is a test rather than a rule.
//
// Four separate times on this project, a SCRIPTED EDIT has silently removed a
// consent-adjacent guard. Taxonomy species 38 exists for exactly this and it
// kept firing anyway — most recently on 2026-09-02, when a cleanup pass that
// was only supposed to strip debug logging deleted BOTH guards inside
// enableOtherParty, including the one that refuses to arm buyer capture
// without a recorded grant. It was caught by reading the diff. It should not
// have needed to be caught by a human at all.
//
// The founder's instruction, and the right call: "A rule that's been violated
// four times isn't being followed. Give it a red light instead."
//
// So: each guard below is asserted to EXIST, by its own text, in its own file.
// Deleting one turns this red immediately, with the file and the reason named.
//
// WHAT THIS FILE IS NOT. It does not test that the guards WORK — each has its
// own behavioural tests elsewhere, and those are the ones that prove the
// semantics. This file answers a narrower question that no behavioural test
// answers, because a deleted guard usually deletes its own failing case too:
// **is the guard still there at all?**
//
// If you are changing one of these deliberately, change the string here in the
// same commit and say why. That is the point: it makes removing a consent
// guard a decision someone had to write down, instead of a side effect.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** CRLF-normalised: this repo has core.autocrlf=true, so a source file read
 *  here arrives with \r\n and any multi-line anchor would silently never
 *  match — a hollow green in the very file meant to prevent hollow greens. */
const read = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), 'utf8').split('\r\n').join('\n')

type Guard = {
  file: string
  /** Exact source text. Not a regex — an approximation here would pass while
   *  the real guard was rewritten into something weaker. */
  guard: string
  /** What becomes possible if this line disappears. Written for whoever sees
   *  this test go red at 3am. */
  ifRemoved: string
}

const GUARDS: Guard[] = [
  {
    file: 'src/main/consent-gate.ts',
    guard: 'if (consent.recordOtherParty !== true) {',
    ifRemoved: 'the audio gate would open for a call with no other-party grant'
  },
  {
    file: 'src/main/consent-gate.ts',
    guard: 'if (consent.recordOtherParty !== true) return null',
    ifRemoved: 'a caller asking "may I capture?" would get a permissive answer'
  },
  {
    file: 'src/main/calls-fs.ts',
    guard: "recordOtherParty: status === 'consented' && v.recordOtherParty === true,",
    ifRemoved:
      'recordOtherParty would be trusted FROM INPUT rather than computed from status — a tampered or stale record could claim a permission nobody gave'
  },
  {
    file: 'src/main/calls-fs.ts',
    guard: 'return call.consent != null && call.consent.recordOtherParty !== true',
    ifRemoved:
      'consent-retention would stop stripping the other party from calls recorded without their consent'
  },
  {
    file: 'src/main/calls.ts',
    guard: "if (current?.consent?.recordOtherParty === true) {",
    ifRemoved:
      "the other party's NAME, extracted from a self-introduction, would be persisted for a call whose buyer consent was revoked mid-call"
  },
  {
    file: 'src/main/contact-intelligence-ipc.ts',
    guard: "if (call.consent?.recordOtherParty !== true) {",
    ifRemoved: 'the post-hoc "detect who this was" scan would read buyer speech without consent'
  },
  {
    file: 'src/main/contact-intelligence-ipc.ts',
    guard: "if (call.consent?.recordOtherParty !== true) return",
    ifRemoved: 'auto-create-contact would act on an identity derived from unconsented audio'
  },
  {
    file: 'src/main/deal-tier1.ts',
    guard: 'if (!consentPermitsCapture(callId)) {',
    ifRemoved: "the buyer's words would reach a third-party LLM without a grant"
  },
  {
    file: 'src/main/deal-tier2.ts',
    guard: 'if (!consentPermitsCapture(callId)) {',
    ifRemoved: "the buyer's words would reach a third-party LLM without a grant"
  },
  {
    file: 'src/main/live-cue.ts',
    guard: 'if (!consentPermitsCapture(callId)) {',
    ifRemoved: "the buyer's words would reach a third-party LLM without a grant"
  },
  {
    file: 'src/main/live/call-journal.ts',
    guard: "if (!consent || consent.recordOtherParty !== true) {",
    ifRemoved:
      'the raw crash-recovery journal would keep unconsented buyer audio on disk after the call'
  },
  {
    file: 'src/main/loopback.ts',
    guard: '!loadAppSettings().allowOtherPartyRecording ||',
    ifRemoved: 'the master switch would stop being able to refuse capture'
  },
  {
    file: 'src/renderer/src/features/live/useTranscription.ts',
    guard: "if (!before || before.status !== 'consented' || before.recordOtherParty !== true) return",
    ifRemoved:
      'buyer capture could be armed with no recorded grant — THIS IS THE ONE A SCRIPTED CLEANUP DELETED on 2026-09-02'
  },
  {
    file: 'src/renderer/src/features/consent/prefs.ts',
    guard: "return r.status === 'consented' && r.recordOtherParty === true",
    ifRemoved: 'the renderer would treat a non-consented standing record as permission'
  }
]

describe('every consent guard is still present (species 38, fourth occurrence)', () => {
  it.each(GUARDS)('$file — $ifRemoved', ({ file, guard }) => {
    const src = read(file)
    expect(
      src.includes(guard),
      `MISSING CONSENT GUARD in ${file}\n\n  expected to find:\n    ${guard}\n\n` +
        `If you removed this deliberately, update this test in the same commit and say why.\n` +
        `If you did not, something removed a consent guard without you noticing — which has\n` +
        `now happened four times on this project.`
    ).toBe(true)
  })

  // A guard that appears more than once is fine; a FILE that lost its only
  // copy is not. This is the control: it proves the assertions above are
  // reading real files and would notice their absence.
  it('CONTROL — the pinned text is genuinely absent from an unrelated file', () => {
    const unrelated = read('src/main/ai/model-catalog.ts')
    for (const g of GUARDS) {
      expect(unrelated.includes(g.guard)).toBe(false)
    }
  })

  it('CONTROL — every pinned file exists and is non-trivial', () => {
    for (const g of GUARDS) {
      expect(read(g.file).length, `${g.file} is empty or missing`).toBeGreaterThan(200)
    }
  })
})
