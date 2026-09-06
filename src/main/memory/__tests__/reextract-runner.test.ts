// M37 Stage 1 — THE RE-EXTRACTION RUNNER.
//
// The founder approved re-extracting their 73 memories with four conditions:
// snapshot first and byte-verify it (scripts/verification/memory-snapshot.mjs,
// separate on purpose so the snapshot exists before this ever runs), additive
// only, counts before and after, and — new in M37 — "tell me what the app now
// knows about my business that it didn't know yesterday, as sentences."
//
// WHY THIS IS A TEST FILE AND NOT A SCRIPT: it needs `extractMemoriesFromCall`,
// which reaches app-settings, which reaches electron. Every other real-AI
// instrument in this repo solves that the same way — vi.mock('electron') plus
// an explicit env opt-in (memory-quality-eval.test.ts's CALLRISE_EVAL=1). A
// standalone .mjs would need a second, divergent way to stub the same module.
// Skipped by default, and the skip says so in the test NAME rather than
// reporting a pass for a run that did nothing.
//
// SAFETY, and this is the part that matters — it operates on a COPY, never on
// the founder's live store:
//   1. It REFUSES to open a database inside the real profile directory. The
//      check is on the resolved path, so `..` cannot walk back into it.
//   2. It opens the CALLS/CONTACTS/DEALS of the profile READ-ONLY (listCalls
//      and friends never write) and writes only to the copy.
//   3. `--limit` copies N call records into a temp directory rather than
//      pointing the scan at the real one.
//
//   CALLRISE_REEXTRACT=1 \
//   CALLRISE_REEXTRACT_DB=<path to a snapshot copy> \
//   CALLRISE_REEXTRACT_PROFILE=<profile dir holding calls/ contacts/ deals/> \
//   [CALLRISE_REEXTRACT_LIMIT=N] [CALLRISE_EVAL_CHAIN=<catalog id>] \
//   npx vitest run src/main/memory/__tests__/reextract-runner.test.ts
import { copyFileSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/** The app's real profile. A database under here is the founder's live store
 *  and is never opened by this file. */
const REAL_PROFILE = resolve(process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'), 'sales-os')

const runnerUserData = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callrise-reextract-ud-'))
  const chain = (process.env.CALLRISE_EVAL_CHAIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  fs.writeFileSync(
    path.join(dir, 'app-settings.json'),
    JSON.stringify({
      salesBrain: { enabled: true },
      ...(chain.length ? { aiModelAssignments: { 'memory-extract': { chain } } } : {})
    })
  )
  return dir
})

vi.mock('electron', () => ({
  app: { getPath: () => runnerUserData },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    on(): void {}
    show(): void {}
  }
}))

const { openMemoryDb, migrate } = await import('../db')
const { runBackfill } = await import('../backfill')
const { listContacts } = await import('../../contacts-fs')

const OPTED_IN = process.env.CALLRISE_REEXTRACT === '1'
const DB = process.env.CALLRISE_REEXTRACT_DB?.trim() ?? ''
const PROFILE = process.env.CALLRISE_REEXTRACT_PROFILE?.trim() ?? ''
const LIMIT = Number(process.env.CALLRISE_REEXTRACT_LIMIT ?? '0') || 0

interface Row {
  id: string
  scope: string
  category: string
  statement: string
  status: string
  evidence: number
  confidence: number
  createdAt: string
  validFrom: string | null
  /** True when EVERY evidence entry is a synthetic `backfill:contact:` /
   *  `backfill:deal:` id — i.e. this fact was copied 1:1 out of a record the
   *  founder had already typed, not learned from anything said on a call.
   *  The distinction matters for the founder's question ("what does it now
   *  know about my business"): a mechanical restatement of their own contact
   *  form is not new knowledge, and reporting the two together would inflate
   *  the answer with things they told the app themselves. */
  fromRecords: boolean
}

function snapshotRows(db: import('better-sqlite3').Database): Map<string, Row> {
  const rows = db
    .prepare(
      'SELECT id, scope, category, statement, status, evidence, confidence, created_at AS createdAt, valid_from AS validFrom FROM memories'
    )
    .all() as Array<Omit<Row, 'evidence' | 'fromRecords'> & { evidence: unknown }>
  const out = new Map<string, Row>()
  for (const r of rows) {
    let n = 0
    let fromRecords = false
    try {
      const parsed = JSON.parse(String(r.evidence))
      if (Array.isArray(parsed)) {
        n = parsed.length
        fromRecords =
          n > 0 &&
          parsed.every((e) => typeof (e as { callId?: string })?.callId === 'string' && (e as { callId: string }).callId.startsWith('backfill:'))
      }
    } catch {
      n = 0
    }
    out.set(r.id, { ...r, evidence: n, fromRecords })
  }
  return out
}

function tally(rows: Map<string, Row>, key: (r: Row) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows.values()) out[key(r)] = (out[key(r)] ?? 0) + 1
  return out
}

const scopeKind = (scope: string): string => (scope.startsWith('client:') ? 'client' : scope)

describe('M37 — re-extraction of a real store, on a COPY', () => {
  const name = !OPTED_IN
    ? 'NOT RUN — re-extraction is opt-in (CALLRISE_REEXTRACT=1 + _DB + _PROFILE)'
    : 're-extracts every call into the copy, additively, and reports what is new'

  it.skipIf(!OPTED_IN)(
    name,
    async () => {
      expect(DB, 'CALLRISE_REEXTRACT_DB is required').not.toBe('')
      expect(PROFILE, 'CALLRISE_REEXTRACT_PROFILE is required').not.toBe('')

      // ── the refusal ──────────────────────────────────────────────────────
      // Resolved, so `..` cannot walk back into the real profile. This is the
      // guard that makes everything below safe to run at all.
      const dbPath = resolve(DB)
      const inRealProfile = dbPath === REAL_PROFILE || dbPath.startsWith(REAL_PROFILE + sep)
      expect(
        inRealProfile,
        `REFUSED: ${dbPath} is inside the live profile ${REAL_PROFILE}. Re-extraction runs on a snapshot copy, never on the founder's store.`
      ).toBe(false)
      expect(existsSync(dbPath), `no such database: ${dbPath}`).toBe(true)

      const callsSrc = join(PROFILE, 'calls')
      let callsDir = callsSrc
      let limitedTo: number | null = null
      if (LIMIT > 0) {
        // copy N records out rather than pointing the scan at the real folder
        const tmp = mkdtempSync(join(tmpdir(), 'callrise-reextract-calls-'))
        const files = readdirSync(callsSrc)
          .filter((f) => f.endsWith('.json'))
          .sort()
          .slice(0, LIMIT)
        for (const f of files) copyFileSync(join(callsSrc, f), join(tmp, f))
        callsDir = tmp
        limitedTo = files.length
      }

      const db = openMemoryDb(dbPath)
      await migrate(db, dbPath)

      // The report goes to a FILE as well as the console: vitest's default
      // reporter hides console output for a PASSING test, so the first run of
      // this produced a perfect, invisible report.
      const reportPath = process.env.CALLRISE_REEXTRACT_REPORT?.trim() || `${dbPath}.report.md`
      const lines: string[] = []
      const say = (s = ''): void => {
        lines.push(s)
        console.log(s)
      }

      const before = snapshotRows(db)
      say('# Re-extraction report')
      say()
      say('## Before')
      say(`- database: \`${dbPath}\``)
      say(`- profile: \`${PROFILE}\`${limitedTo === null ? '' : `  **LIMITED to ${limitedTo} calls**`}`)
      say(`- memories: **${before.size}**`)
      say(`- by status: ${JSON.stringify(tally(before, (r) => r.status))}`)
      say(`- by scope: ${JSON.stringify(tally(before, (r) => scopeKind(r.scope)))}`)
      say(`- by category: ${JSON.stringify(tally(before, (r) => r.category))}`)

      const progress: string[] = []
      let summary = ''
      let aiFailedEverySingleCall = false
      await runBackfill(
        db,
        {
          includeContacts: true,
          includeDeals: true,
          includeCalls: true,
          rescanAll: true, // the whole point: reconsider every call with the new rules
          callsDir,
          contactsDir: join(PROFILE, 'contacts'),
          dealsDir: join(PROFILE, 'deals')
        },
        (p) => {
          if (p.stage === 'calls' && p.processed % 10 === 0) progress.push(`calls ${p.processed}/${p.total}`)
          if (p.summary) summary = p.summary
          if ((p as { allAiFailed?: boolean }).allAiFailed) aiFailedEverySingleCall = true
        }
      )

      const after = snapshotRows(db)

      // ── the founder's condition, checked rather than asserted in prose ───
      const deleted = [...before.keys()].filter((id) => !after.has(id))
      const rewritten = [...before.entries()].filter(([id, was]) => after.has(id) && after.get(id)!.statement !== was.statement)
      const evidenceLost = [...before.entries()].filter(([id, was]) => after.has(id) && after.get(id)!.evidence < was.evidence)

      const created = [...after.values()].filter((r) => !before.has(r.id))
      const reinforced = [...before.entries()].filter(([id, was]) => after.has(id) && after.get(id)!.evidence > was.evidence)
      const superseded = [...before.entries()].filter(
        ([id, was]) => after.has(id) && was.status !== 'invalidated' && after.get(id)!.status === 'invalidated'
      )

      const learned = created.filter((r) => !r.fromRecords)
      const copied = created.filter((r) => r.fromRecords)

      say()
      say('## After')
      say(`- runner summary: ${summary || '(none reported)'}`)
      if (aiFailedEverySingleCall) say('- **EVERY AI CALL FAILED — the numbers below are about nothing.**')
      say(`- memories: **${before.size} -> ${after.size}** (+${created.length})`)
      say(`  - learned from calls (AI extraction): **${learned.length}**`)
      say(`  - copied from contact/deal records (no AI, mechanical): ${copied.length}`)
      say(`- reinforced (existing rows that gained evidence): ${reinforced.length}`)
      say(`- superseded (closed with a window by a newer fact): ${superseded.length}`)
      say(`- by status: ${JSON.stringify(tally(after, (r) => r.status))}`)
      say(`- by scope: ${JSON.stringify(tally(after, (r) => scopeKind(r.scope)))}`)
      say(`- by category: ${JSON.stringify(tally(after, (r) => r.category))}`)
      say(`- DELETED: ${deleted.length} · REWRITTEN: ${rewritten.length} · EVIDENCE LOST: ${evidenceLost.length}`)

      // ── what the app now knows, as sentences ────────────────────────────
      const contacts = await listContacts(join(PROFILE, 'contacts')).catch(() => [])
      const nameFor = (scope: string): string => {
        if (scope === 'rep') return 'About you'
        if (scope === 'business') return 'About your business'
        if (!scope.startsWith('client:')) return scope
        const id = scope.slice('client:'.length)
        const c = contacts.find((x) => x.id === id)
        return c ? `${c.name}${c.company ? ` — ${c.company}` : ''}` : `client ${id.slice(0, 8)}`
      }
      const group = (rows: Row[]): Array<[string, Row[]]> => {
        const m = new Map<string, Row[]>()
        for (const r of rows) {
          const k = nameFor(r.scope)
          if (!m.has(k)) m.set(k, [])
          m.get(k)!.push(r)
        }
        return [...m.entries()].sort((a, b) => b[1].length - a[1].length)
      }

      say()
      say('## What the app now knows that it did not before')
      say()
      say('_Learned from what was actually said on your calls._')
      if (learned.length === 0) say('\n(nothing — the extractor produced no new facts from these calls)')
      for (const [who, rows] of group(learned)) {
        say()
        say(`### ${who} (${rows.length})`)
        for (const r of rows.sort((a, b) => a.category.localeCompare(b.category))) say(`- ${r.statement}  _(${r.category})_`)
      }
      if (copied.length > 0) {
        say()
        say(`## Also added, copied from records you had already filled in (${copied.length})`)
        say()
        say('_Not new knowledge — these are your own contact and deal fields restated as facts._')
        for (const [who, rows] of group(copied)) say(`- **${who}**: ${rows.length}`)
      }
      if (superseded.length > 0) {
        say()
        say('## What it now knows is no longer true')
        for (const [, was] of superseded) say(`- ~~${was.statement}~~ _(${nameFor(was.scope)}; window closed)_`)
      }

      db.close()
      writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8')
      console.log(`\nreport written: ${reportPath}\n`)

      // The founder's condition, as assertions. A run that violated any of
      // these must fail loudly rather than be read off the log.
      expect(deleted, `rows DELETED by the re-run: ${deleted.join(', ')}`).toEqual([])
      expect(rewritten.map(([id]) => id), 'rows REWRITTEN by the re-run').toEqual([])
      expect(evidenceLost.map(([id]) => id), 'rows that LOST evidence').toEqual([])
    },
    3_600_000
  )
})
