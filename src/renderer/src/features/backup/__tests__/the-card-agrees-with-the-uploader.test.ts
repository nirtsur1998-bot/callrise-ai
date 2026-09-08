// @vitest-environment happy-dom
//
// BUG-214 — the Backup card's readout must agree with what the uploader
// actually does.
//
// A row whose switch reads ON while nothing is uploaded is the card lying, and
// this instance was introduced by the fix immediately upstream of it: BUG-205
// gated the Sales Brain push on BOTH its own toggle and the transcripts toggle
// (`if (syncScope.salesBrain && syncScope.transcripts)`), and this list was not
// told.
//
// On a FRESH profile that is the shipped state. `salesBrain` defaults true and
// `transcripts` defaults false, so out of the box the card read "Sales Brain
// memories: on" and counted it in "N of 7 synced", while the brain had never
// left the machine and never would.
//
// The shape is worth naming because it is the third time this week: a fix that
// changes what the app DOES, landing correctly, while a second surface that
// describes the same thing keeps its old answer. The uploader and the readout
// are the pair that must agree, and nothing made them.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CARD = readFileSync(join(__dirname, '..', 'BackupCard.tsx'), 'utf8')
const BACKUP = readFileSync(
  join(__dirname, '..', '..', '..', '..', '..', 'main', 'backup.ts'),
  'utf8'
)

describe('the Backup card agrees with the uploader', () => {
  it('the uploader still requires BOTH toggles — the premise of everything below', () => {
    // If this ever stops being true, the blocked state below becomes the lie
    // instead of the fix, so it is asserted first rather than assumed.
    expect(
      BACKUP,
      'the Sales Brain push no longer requires the transcripts toggle, so the card must stop ' +
        'claiming it is blocked'
    ).toContain('if (syncScope.salesBrain && syncScope.transcripts) {')
  })

  it('the card knows the Sales Brain row is blocked while transcripts are off', () => {
    // Anchored on the DECLARATION, not on the substring. The first version of
    // this assertion matched `key === 'salesBrain' && !syncScope.transcripts`
    // anywhere in the file, and the syncedCount filter below contains the same
    // words — so it stayed green with the row logic deleted. A red check
    // caught it. Two places must agree, so each is asserted where it lives.
    expect(
      CARD,
      'the row does not model the transcripts dependency, so it shows a preference as an outcome'
    ).toMatch(/const blocked = key === 'salesBrain' && !syncScope\.transcripts/)
  })

  it('the switch itself reads off when the upload is blocked', () => {
    // Not merely a label beside an ON switch: the control is what people read.
    expect(CARD).toMatch(/checked=\{syncScope\[key\] && !blocked\}/)
  })

  it('the "N of 7 synced" count excludes the blocked row', () => {
    // The count was true of the switches and false of the account. A summary
    // number that disagrees with the list under it is worse than no number.
    const m = /const syncedCount = OPTIONAL_ITEMS\.filter\(([\s\S]{0,220}?)\)\.length/.exec(CARD)
    expect(m, 'syncedCount is gone or was restructured').not.toBeNull()
    expect(
      m?.[1],
      'the count still counts a row whose upload is blocked by another toggle'
    ).toMatch(/salesBrain/)
  })

  it('the user preference is preserved, not silently forced off', () => {
    // `setScope` must still write what the user chose. Blocking the OUTCOME is
    // right; rewriting their stored preference behind their back is not, and
    // it would also mean turning transcripts on later did not restore it.
    expect(CARD).toContain('onChange={(v) => setScope(key, v)}')
    expect(
      CARD,
      'the card writes syncScope.salesBrain = false when transcripts are off — that destroys the ' +
        "user's preference instead of describing the outcome"
    ).not.toMatch(/setScope\('salesBrain', false\)/)
  })
})
