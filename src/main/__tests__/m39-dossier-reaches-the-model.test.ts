// @vitest-environment node
//
// M39 Stage 3 — the two things that decide whether the dossier is a feature or
// a dead code path, neither of which any existing test could fail on.
//
// 1. THE contactId CHAIN. `m39-dossier-in-the-cue-prompt.test.ts` enters at
//    `liveCue({ contactId })` with the value already in hand, so it proves what
//    happens AFTER the id arrives and nothing about whether it ever does. The
//    id crosses three joints on its way — renderer hook -> preload bridge ->
//    ipc handler -> liveCue — and at every one of them the failure mode is the
//    same shape: the value is quietly dropped, `dossierContactId` reads '',
//    `ensureDossier` is never called, the prompt is byte-for-byte the
//    pre-M39 prompt, and every test in the suite still passes. These are
//    source-reading assertions, which is a weaker instrument than a live
//    drive; they are here because the alternative was claiming the chain from
//    a reading with nothing pinning it.
//
// 2. THE DEAL STAGE. `dossier-store.ts` hard-coded `stageLabel: null` while
//    `scripts/verification/m39-dossier-measure.ts` resolved the label from
//    deal-stages.json — so the MEASURED dossier read "stage: Won" and the one
//    the product sent had no stage in it. Two instruments, and the richer one
//    was not the product. Measured on the founder's records after the fix:
//    12 of 12 contacts whose deal sits in a named stage now carry it; before
//    it, 0 of 12. This test is the red-check made permanent.
import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDossier, clearDossier } from '../live/dossier-store'

const ROOT = join(__dirname, '..', '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')

/** Comments are stripped before every source assertion: a check for
 *  `contactId` that matches the doc comment explaining contactId is a guard
 *  flagging its own documentation, which has now happened twice in this
 *  milestone. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

describe('M39 — the contactId reaches the main process', () => {
  it('the preload bridge forwards contactId in the live:cue payload', () => {
    const src = code(read('preload', 'index.ts'))
    // The bridge builds a NEW object literal rather than forwarding its
    // arguments, so a fifth parameter that is accepted and never placed in the
    // literal type-checks, runs, and silently drops the dossier.
    const payload = src.match(/ipcRenderer\.invoke\('live:cue',\s*\{[\s\S]*?\}\)/)
    expect(payload, 'preload must invoke live:cue with an object payload').not.toBeNull()
    expect(payload?.[0]).toContain('contactId')
    expect(src).toMatch(/liveCue:\s*\([\s\S]*?contactId\??:\s*string/)
  })

  it('the ipc handler passes the whole payload through, not selected fields', () => {
    const src = code(read('main', 'live-cue.ts'))
    // `(_e, input) => liveCue(input)`. A handler that destructured the four
    // original fields and rebuilt them would keep every other test green.
    expect(src).toMatch(/ipcMain\.handle\('live:cue',\s*\(_e,\s*input:\s*unknown\)\s*=>\s*liveCue\(input\)\)/)
  })

  it('liveCue reads contactId off the body and hands it to the store', () => {
    const src = code(read('main', 'live-cue.ts'))
    expect(src).toContain("typeof body.contactId === 'string' ? body.contactId : ''")
    expect(src).toMatch(/ensureDossier\(\s*app\.getPath\('userData'\),\s*dossierCallId,\s*dossierContactId/)
  })

  it('LiveView pushes the matched meeting into the PROVIDER, not only its own state', () => {
    // LiveView keeps a local `currentMeeting` AND the provider keeps one. The
    // dossier reads the provider's, through meetingContactIdRef. If LiveView
    // ever set only its local copy the chip would still work, the deal facts
    // would still work, and the dossier alone would go silently empty.
    const src = code(read('renderer', 'src', 'features', 'live', 'LiveView.tsx'))
    expect(src).toMatch(/liveCall\.setCurrentMeeting\(/)
  })

  it('the provider keeps the meeting contact current AND passes it to useLiveCues', () => {
    const src = code(read('renderer', 'src', 'features', 'live', 'LiveCallProvider.tsx'))
    expect(src).toContain('meetingContactIdRef.current = currentMeeting?.contactId ?? null')
    // Asserting only that the identifier appears somewhere in the file would be
    // satisfied by its own declaration — the getter can exist, be correct, and
    // never be handed to the hook that calls the cue. It is the LAST positional
    // argument to useLiveCues, so pin it inside that call.
    const call = src.match(/useLiveCues\([\s\S]*?\n\s*\)/)
    expect(call, 'LiveCallProvider must call useLiveCues').not.toBeNull()
    expect(call?.[0]).toContain('getMeetingContactId')
  })

  it('useLiveCues reads the contact at REQUEST time, never captures it', () => {
    // A calendar match can land minutes into a call. A captured value would
    // pin "no client" for the rest of the conversation, and the only symptom
    // would be a dossier that is empty on exactly the calls that started
    // before the match.
    const src = code(read('renderer', 'src', 'features', 'live', 'useLiveCues.ts'))
    expect(src).toContain('getMeetingContactIdRef.current?.() ?? undefined')
  })
})

describe('M39 — the dossier carries the deal stage', () => {
  const dirs: string[] = []
  afterEach(() => {
    clearDossier()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const profile = (stagesFile?: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'm39-stage-'))
    dirs.push(dir)
    for (const sub of ['contacts', 'calls', 'tasks', 'deals', 'objection-queue']) {
      mkdirSync(join(dir, sub))
    }
    writeFileSync(join(dir, 'contacts', 'c1.json'), JSON.stringify({ id: 'c1', name: 'Jack' }))
    writeFileSync(
      join(dir, 'deals', 'd1.json'),
      JSON.stringify({ id: 'd1', contactId: 'c1', title: 'Jack', stageId: 'went-quiet' })
    )
    if (stagesFile !== undefined) {
      writeFileSync(join(dir, 'deal-stages.json'), JSON.stringify(stagesFile))
    }
    return dir
  }

  const REAL_SHAPE = {
    stages: [
      { id: 'won', label: 'Won', kind: 'won' },
      { id: 'went-quiet', label: 'Went quiet', kind: 'went-quiet' }
    ],
    updatedAt: '2026-09-06T04:44:50.949Z'
  }

  it('resolves the stage id to the label the rep sees', async () => {
    const text = await ensureDossier(profile(REAL_SHAPE), 'call-1', 'c1')
    expect(text).toContain('stage: Went quiet')
  })

  it('accepts a bare array as well as the { stages } wrapper', async () => {
    const text = await ensureDossier(profile(REAL_SHAPE.stages), 'call-2', 'c1')
    expect(text).toContain('stage: Went quiet')
  })

  it('says nothing rather than something wrong when the stage file is absent', async () => {
    const text = await ensureDossier(profile(), 'call-3', 'c1')
    expect(text).toContain('Jack')
    expect(text).not.toContain('stage:')
    expect(text).not.toContain('went-quiet') // never the raw id
  })

  it('says nothing when the id is not in the pipeline', async () => {
    const text = await ensureDossier(profile({ stages: [{ id: 'won', label: 'Won' }] }), 'call-4', 'c1')
    expect(text).not.toContain('stage:')
  })

  it('survives a corrupt stage file without costing the dossier', async () => {
    const dir = profile(REAL_SHAPE)
    writeFileSync(join(dir, 'deal-stages.json'), '{not json')
    const text = await ensureDossier(dir, 'call-5', 'c1')
    expect(text).toContain('Jack') // the dossier still arrives
    expect(text).not.toContain('stage:')
  })

  it('ignores a label that is not a string, rather than rendering it', async () => {
    const text = await ensureDossier(
      profile({ stages: [{ id: 'went-quiet', label: { evil: true } }] }),
      'call-6',
      'c1'
    )
    expect(text).not.toContain('stage:')
    expect(text).not.toContain('evil')
  })
})
