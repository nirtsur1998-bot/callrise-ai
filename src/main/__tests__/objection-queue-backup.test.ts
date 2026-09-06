// BUG-189 — the objection queue's place in the backup, pinned as text where
// the wiring lives in modules that cannot be imported under vitest (backup.ts
// and calls.ts pull in electron, supabase and the job system).
//
// Three claims, each of which the founder's condition for syncing rests on:
//   1. the queue is pushed, pulled AND scrubbed under the TRANSCRIPTS toggle —
//      never unconditionally, never under a toggle of its own;
//   2. the items are mined from the SAVED call record (retention applied), not
//      from the live transcript — so nothing consent strips can reach the queue;
//   3. the SQL the founder pastes creates the table the code names.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string): string => readFileSync(join(__dirname, '..', '..', '..', rel), 'utf8')
const backup = read('src/main/backup.ts')
const calls = read('src/main/calls.ts')
const sql = read('supabase/2026-09-objection-queue-backup.sql')

/** The text of the `if (syncScope.transcripts) { ... }` blocks, so a push or
 *  pull that mentions the table OUTSIDE such a block is caught. */
function transcriptsBlocks(src: string): string[] {
  const out: string[] = []
  const re = /if \(syncScope\.transcripts\) \{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    out.push(src.slice(m.index, i + 1))
  }
  return out
}

describe('the queue syncs under the transcripts toggle', () => {
  const blocks = transcriptsBlocks(backup)

  it('is pushed inside a syncScope.transcripts block, with tombstones as deleted rows', () => {
    const push = blocks.find((b) => b.includes("upsertRows(client, 'backup_objection_queue'"))
    expect(push, 'no transcripts-gated push of backup_objection_queue').toBeTruthy()
    expect(push).toContain('includeDeleted: true')
    expect(push).toContain('deleted: i.deleted === true')
  })

  it('is pulled inside a syncScope.transcripts block through reconcileStore + importQueueItem', () => {
    const pull = blocks.find((b) => b.includes("fetchAllRows(client, 'backup_objection_queue'"))
    expect(pull, 'no transcripts-gated pull of backup_objection_queue').toBeTruthy()
    expect(pull).toContain('reconcileStore(')
    expect(pull).toContain('importObjectionQueueItem(d, payload, { onlyIfNewer: true })')
  })

  it('every mention of the table in backup.ts is either inside a transcripts block or in the transcripts scrub', () => {
    const mentions = backup.split("'backup_objection_queue'").length - 1
    const inBlocks = blocks.reduce((n, b) => n + (b.split("'backup_objection_queue'").length - 1), 0)
    const scrub = backup.slice(backup.indexOf("if (key === 'transcripts') {"), backup.indexOf("} else if (key === 'attachments')"))
    const inScrub = scrub.split("'backup_objection_queue'").length - 1
    expect(mentions).toBeGreaterThan(0)
    expect(inBlocks + inScrub).toBe(mentions)
  })

  it('switching transcripts off deletes the queue rows in the same scrub that re-pushes the calls quote-free', () => {
    const scrub = backup.slice(backup.indexOf("if (key === 'transcripts') {"), backup.indexOf("} else if (key === 'attachments')"))
    expect(scrub).toContain('touchAllCallsForRepush(callsDir())')
    expect(scrub).toContain(".from('backup_objection_queue')")
    expect(scrub).toContain('.delete()')
    expect(scrub).toContain(".eq('user_id', userId)")
  })
})

describe('what can reach the queue', () => {
  it('mining reads the SAVED call record (retention applied), never the live transcript', () => {
    const start = calls.indexOf('async function mineCallIntoQueue(')
    expect(start).toBeGreaterThan(0)
    // CRLF on this machine: a literal '\n}\n' never matches and the slice
    // would run to the end of the file, dragging in every other function.
    const close = /\r?\n\}\r?\n/g
    close.lastIndex = start
    const end = close.exec(calls)
    expect(end, 'could not find the end of mineCallIntoQueue').toBeTruthy()
    const body = calls.slice(start, end!.index)
    expect(body.length).toBeLessThan(2000) // one function, not the file
    expect(body).toContain('await getCall(callsDir(), callId)')
    expect(body).toContain('mineObjections(speechSegments(call.segments)')
    expect(body).not.toContain('currentTranscript(')
    expect(body).not.toContain('liveCallInfo(')
  })
})

describe('the SQL the founder pastes', () => {
  it('creates the table the code names, with RLS and the one delete policy the scrub needs', () => {
    expect(sql).toContain('create table if not exists public.backup_objection_queue')
    expect(sql).toContain('alter table public.backup_objection_queue enable row level security')
    expect(sql).toContain('for delete using (user_id = auth.uid())')
    expect(sql).toContain('grant select, insert, update, delete on public.backup_objection_queue to authenticated')
  })
})
