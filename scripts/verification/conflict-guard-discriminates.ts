// BUG-187 — does the FIXED guard discriminate, on the founder's real records?
//
// `conflict-guard-reach.ts` measures the predicate against the uploaded
// PAYLOAD, which is the comparison the old guard made and the reason it was
// inert. This measures the comparison the FIX makes: local against what
// `importCall` actually WROTE.
//
// The discrimination test has to answer three questions, and a guard that gets
// any one wrong is worse than the inert one it replaces:
//
//   1. BUG-138's case — nothing edited anywhere. Must write NO conflict.
//      This is the burst that put 201 files on the founder's machine.
//   2. A genuine two-machine conflict — the other device renamed the call.
//      Must STILL write one, or a real losing edit disappears.
//   3. A cloud edit the importer DISCARDS anyway (the local transcript wins).
//      Must write no conflict: nothing of the user's was lost.
//
// Read-only with respect to the founder's profile: records are COPIED into a
// scratch directory and every write happens there.
//
// usage: conflict-guard-discriminates.ts <userDataDir> [howMany]
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  importCall,
  callBackupPayload,
  callFullBackupPayload,
  type Call
} from '../../src/main/calls-fs'

const PROFILE = process.argv[2]
const HOW_MANY = Number(process.argv[3] || 60)
if (!PROFILE) throw new Error('usage: conflict-guard-discriminates.ts <userDataDir> [howMany]')

/**
 * The fix's predicate, extracted VERBATIM so this cannot drift from what ships.
 *
 * It needs its helper too — `importWouldDiscard` calls `isEmptyValue`, and the
 * first version of this extractor pulled only the predicate and died with
 * "isEmptyValue is not defined". That failure is the technique working: an
 * extractor that silently dropped the helper would have measured a DIFFERENT
 * predicate than the one that ships, which is precisely what verbatim
 * extraction exists to prevent. Every function the predicate depends on is
 * named here, and a missing one throws rather than degrading.
 */
function extractImportWouldDiscard(): (a: unknown, b: unknown) => boolean {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'backup-core.ts'), 'utf8')
  const needed = ['isEmptyValue', 'importWouldDiscard']
  const parts: string[] = []
  for (const name of needed) {
    const start = src.indexOf(`function ${name}(`)
    if (start === -1) throw new Error(`${name} is not in backup-core.ts — update this extractor`)
    const end = src.indexOf('\n}', start)
    if (end === -1) throw new Error(`could not find the end of ${name}`)
    parts.push(src.slice(start, end + 2))
  }
  const body = parts
    .join('\n')
    .replace(/: unknown/g, '')
    .replace(/: string/g, '')
    .replace(/: boolean/g, '')
    .replace(/ as Record<string, unknown>/g, '')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${body}; return importWouldDiscard`)() as (a: unknown, b: unknown) => boolean
}
const importWouldDiscard = extractImportWouldDiscard()

const source = join(PROFILE, 'calls')
const records: Call[] = []
for (const f of readdirSync(source).filter((x) => x.endsWith('.json'))) {
  try {
    const c = JSON.parse(readFileSync(join(source, f), 'utf8')) as Call
    if (c.deleted !== true) records.push(c) // condition (d) blocks tombstones
  } catch {
    /* unreadable record */
  }
  if (records.length >= HOW_MANY) break
}

type Scenario = {
  name: string
  mustConflict: boolean
  edit: (payload: Record<string, unknown>, local: Call) => void
}

const SCENARIOS: Scenario[] = [
  {
    name: "BUG-138's case — nothing edited on either side",
    mustConflict: false,
    edit: () => {}
  },
  {
    name: 'genuine conflict — the other machine renamed the call',
    mustConflict: true,
    edit: (p) => {
      p.title = 'renamed on the other machine'
    }
  },
  {
    name: 'cloud edited the transcript, which the import discards (local wins)',
    mustConflict: false,
    edit: (p) => {
      p.segments = [{ speaker: 0, text: 'a different transcript', role: 'rep' }]
      p.preview = 'a different transcript'
    }
  }
]

async function main(): Promise<void> {
  console.log(`records under test: ${records.length} (live only; tombstones excluded)\n`)
  for (const [scopeLabel, build] of [
    ['transcripts OFF', callBackupPayload],
    ['transcripts ON ', callFullBackupPayload]
  ] as const) {
    console.log(scopeLabel)
    for (const s of SCENARIOS) {
      let wouldConflict = 0
      const dir = mkdtempSync(join(tmpdir(), 'discriminate-'))
      for (const local of records) {
        // The record as it sits on disk before the pull.
        writeFileSync(join(dir, `${local.id}.json`), JSON.stringify(local), 'utf8')
        const payload = build(local) as Record<string, unknown>
        s.edit(payload, local)
        // What reconcileStore does to every incoming row before importing it.
        payload.updatedAt = new Date(Date.parse(local.updatedAt) + 600_000).toISOString()
        const written = await importCall(dir, payload)
        if (written && importWouldDiscard(local, written)) wouldConflict++
      }
      rmSync(dir, { recursive: true, force: true })
      const verdict = s.mustConflict
        ? wouldConflict === records.length
          ? 'PASS'
          : 'FAIL — a real losing edit would be lost'
        : wouldConflict === 0
          ? 'PASS'
          : 'FAIL — manufactures conflicts'
      console.log(
        `  ${String(wouldConflict).padStart(4)}/${records.length} conflicts   ` +
          `${verdict.padEnd(38)} ${s.name}`
      )
    }
    console.log('')
  }
  if (!existsSync(source)) throw new Error('source vanished mid-run')
}

void main()
