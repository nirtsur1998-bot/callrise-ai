// BUG-200 / BUG-202 — every category that can be UPLOADED must be ERASABLE.
//
// Seven categories of user data can be backed up. Five could be removed again
// when the user switched them off; two could not, and they were exactly the two
// that default ON: the whole Sales Brain (`memory.db`) and Rise chat threads.
// Switching either off stopped future uploads and left everything already
// uploaded in place, permanently, with no path in the product to remove it.
//
// The near-miss underneath it was worse than the gap. `drainPendingScrubs` was
// an if/else-if chain with NO else, so a key added to SCRUB_KEYS without a
// matching branch fell through every test, threw nothing, was not pushed onto
// `remaining`, and was written out of the pending queue AS THOUGH ITS SCRUB HAD
// SUCCEEDED. The obvious one-line fix for BUG-200 — "add salesBrain to
// SCRUB_KEYS" — would therefore have shipped a Backup card reporting an erase
// that never happened. The founder caught that in review; this file is what
// stops it coming back.
//
// Three claims, each checked a different way:
//   1. the key list is EXHAUSTIVE over BackupSyncScope (type-level, plus a
//      runtime count so a widened type cannot pass unnoticed);
//   2. every key in it has a real branch in the drain chain (source scan);
//   3. the chain ends in an `else` that THROWS, so a future key without a
//      branch fails loudly instead of reporting success.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..')
const BACKUP_TS = readFileSync(join(ROOT, 'src', 'main', 'backup.ts'), 'utf8')
const SETTINGS_TS = readFileSync(join(ROOT, 'src', 'main', 'app-settings.ts'), 'utf8')

/** The scope keys as the SETTINGS module declares them — read from the
 *  interface rather than from backup.ts, so the two files must agree. */
function syncScopeKeys(): string[] {
  const block = /export interface BackupSyncScope \{([\s\S]*?)\n\}/.exec(SETTINGS_TS)
  expect(block, 'BackupSyncScope is no longer declared as an interface — this guard needs updating').not.toBeNull()
  return [...(block?.[1] ?? '').matchAll(/^\s{2}(\w+):\s*boolean/gm)].map((m) => m[1])
}

/** The keys backup.ts says can be scrubbed. */
function scrubKeys(): string[] {
  const block = /const SCRUB_KEY_SET: Record<ScrubKey, true> = \{([\s\S]*?)\n\}/.exec(BACKUP_TS)
  expect(block, 'SCRUB_KEY_SET is gone — a category may have lost its removal path').not.toBeNull()
  return [...(block?.[1] ?? '').matchAll(/^\s{2}(\w+):\s*true/gm)].map((m) => m[1])
}

describe('every uploadable category can be erased', () => {
  it('the scrub key set covers EVERY sync scope key, with none invented', () => {
    const scope = syncScopeKeys()
    const scrub = scrubKeys()
    expect(scope.length, 'no scope keys found — the guard would pass vacuously').toBeGreaterThanOrEqual(7)
    expect([...scrub].sort(), 'a category can be uploaded that cannot be erased').toEqual([...scope].sort())
  })

  it('every scrub key has a real branch in drainPendingScrubs', () => {
    // The type system makes the KEY mandatory; only a source scan can show the
    // BRANCH exists, because a missing branch is a runtime fall-through rather
    // than a type error.
    const drain = /async function drainPendingScrubs\(([\s\S]*?)\n\}/.exec(BACKUP_TS)
    expect(drain, 'drainPendingScrubs is gone or was renamed').not.toBeNull()
    const body = drain?.[1] ?? ''
    const missing = scrubKeys().filter((k) => !new RegExp(`key === '${k}'`).test(body))
    expect(
      missing,
      'these keys are queued for scrubbing and have no branch that deletes anything — ' +
        'they would fall through and be marked as scrubbed'
    ).toEqual([])
  })

  it('the chain ends in an else that THROWS, not a silent fall-through', () => {
    const drain = /async function drainPendingScrubs\(([\s\S]*?)\n\}/.exec(BACKUP_TS)
    const body = drain?.[1] ?? ''
    // an `else {` that is not `else if`, containing a throw
    const hasTerminalElse = /\}\s*else\s*\{[\s\S]*?throw new Error\([\s\S]*?\}/.test(body)
    expect(
      hasTerminalElse,
      'drainPendingScrubs must end in `else { throw ... }`. Without it a key added to ' +
        'SCRUB_KEY_SET without a branch is silently written out of the pending queue as ' +
        'though its scrub succeeded — the exact near-miss BUG-200 was reviewed for.'
    ).toBe(true)
  })

  it('the two categories that default ON are both erasable — the ones the gap was found in', () => {
    // Named explicitly rather than left to the exhaustiveness check, because
    // these two are the reason this file exists and a future edit that drops
    // one should fail on a line that says so.
    const scrub = scrubKeys()
    expect(scrub, 'the Sales Brain must be erasable').toContain('salesBrain')
    expect(scrub, 'Rise conversations must be erasable').toContain('riseConversations')
    const drain = /async function drainPendingScrubs\(([\s\S]*?)\n\}/.exec(BACKUP_TS)?.[1] ?? ''
    expect(/scrubSalesBrainDb\(/.test(drain), 'the Sales Brain branch must call the Storage erase').toBe(true)
    expect(/backup_rise_conversations/.test(drain), 'the Rise branch must delete from the table').toBe(true)
  })

  it('the backend permits both deletes — the SQL exists and is committed', () => {
    // The client half is useless alone: without these two policies RLS refuses
    // the delete and the key retries forever. The migration is handed to the
    // founder to run; this pins that it exists and covers both.
    const sql = readFileSync(join(ROOT, 'supabase', '2026-09-erase-paths.sql'), 'utf8')
    expect(sql).toMatch(/create policy "own rows delete" on public\.backup_rise_conversations/)
    expect(sql).toMatch(/create policy "own sales-brain db delete" on storage\.objects/)
    expect(sql).toMatch(/bucket_id = 'sales-brain'/)
  })
})
