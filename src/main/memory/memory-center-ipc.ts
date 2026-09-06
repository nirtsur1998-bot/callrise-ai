// M25 Sales Brain Phase 5 — IPC surface for the Memory Center (spec section
// 4, the trust UI): browse, edit, pin, delete, changelog, forget-everything,
// and per-call review/exclusion. Every handler gates on isSalesBrainEnabled()
// the same way every other memory-touching call site does.
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { isSalesBrainEnabled } from '../app-settings'
import { getCall, setCallSalesBrainExcluded } from '../calls-fs'
import { getLastInitResult, getMemoryDb } from './memory-runtime'
import { embedText } from './embeddings'
import {
  buildChangelog,
  deleteMemory,
  forgetCallContribution,
  forgetEverything,
  listMemories,
  listMemoriesByCallId,
  setMemoryPinned,
  updateMemoryStatement
} from './memories-store'
import type { Memory, MemoryScope, MemoryStatus } from './types'
import { temporalBackfillRecord, type TemporalBackfillRecord } from './temporal-backfill'

function noDb<T>(fallback: T): T {
  return fallback
}

/**
 * AUDIT FIX (2026-08-24) — the four states an empty result can mean, made
 * distinguishable. 'off' and 'unavailable' each have a DIFFERENT correct user
 * action from 'empty', and the old boolean collapsed all three.
 */
export type SalesBrainStatus =
  | { state: 'off' }
  | { state: 'unavailable'; detail: string }
  | { state: 'empty' }
  | { state: 'ready'; count: number }

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}

let registered = false

export function registerMemoryCenter(): void {
  if (registered) return
  registered = true

  // AUDIT FIX (2026-08-24) — a status any caller can ACT on.
  //
  // 'salesBrain:memories:list' returns [] and never rejects, for three
  // unrelated reasons: Sales Brain is off (the SHIPPING DEFAULT —
  // EMPTY_SALES_BRAIN is { enabled: false }), the DB is unavailable because
  // migration failed and left db null while the flag stayed on, or the brain
  // is genuinely empty. Rise read `rows.length === 0` as proof of the third
  // and told new users "your Sales Brain is empty — import your call
  // history". Importing cannot help in either of the other two cases:
  // initSalesBrain() returns before it even creates the DB file when the flag
  // is off, and every extraction hook is master-gated. So the copy named a
  // wrong cause and prescribed work that could not work, on the state most
  // new installs are actually in.
  //
  // Deliberately a NEW channel rather than changing what memories:list
  // returns — that shape is consumed in several places and widening it would
  // be a silent behaviour change at each one.
  ipcMain.handle('salesBrain:status', async (): Promise<SalesBrainStatus> => {
    if (!isSalesBrainEnabled()) return { state: 'off' }
    const db = getMemoryDb()
    if (!db) {
      return { state: 'unavailable', detail: getLastInitResult()?.detail ?? 'not initialised' }
    }
    // Cheap: the count, not the rows.
    const count = listMemories(db, {}).length
    return count === 0 ? { state: 'empty' } : { state: 'ready', count }
  })

  // M36 Stage 3 item 5, step 5 — "the app can tell you what it did to your
  // data": the temporal backfill's record (ran with these counts, skipped
  // with this reason, or none yet), so the Memory Center shows how many
  // facts carry a real date and how many an approximate one. Read-only.
  ipcMain.handle('salesBrain:temporal:record', async (): Promise<TemporalBackfillRecord | null> => {
    if (!isSalesBrainEnabled()) return null
    const db = getMemoryDb()
    if (!db) return null
    try {
      return temporalBackfillRecord(db)
    } catch {
      return null
    }
  })

  ipcMain.handle(
    'salesBrain:memories:list',
    async (_e, opts: unknown): Promise<Memory[]> => {
      if (!isSalesBrainEnabled()) return noDb([])
      const db = getMemoryDb()
      if (!db) return []
      const o = (opts && typeof opts === 'object' ? opts : {}) as { scope?: string; status?: string }
      return listMemories(db, {
        scope: typeof o.scope === 'string' ? (o.scope as MemoryScope) : undefined,
        status: typeof o.status === 'string' ? (o.status as MemoryStatus) : undefined
      })
    }
  )

  ipcMain.handle(
    'salesBrain:memories:update',
    async (_e, id: unknown, newStatement: unknown): Promise<{ ok: boolean }> => {
      if (!isSalesBrainEnabled() || typeof id !== 'string' || typeof newStatement !== 'string') {
        return { ok: false }
      }
      const text = newStatement.trim().slice(0, 500)
      if (!text) return { ok: false }
      const db = getMemoryDb()
      if (!db) return { ok: false }
      const embedding = await embedText(text)
      const updated = updateMemoryStatement(db, id, text, embedding)
      return { ok: !!updated }
    }
  )

  ipcMain.handle(
    'salesBrain:memories:setPinned',
    async (_e, id: unknown, pinned: unknown): Promise<{ ok: boolean }> => {
      if (!isSalesBrainEnabled() || typeof id !== 'string') return { ok: false }
      const db = getMemoryDb()
      if (!db) return { ok: false }
      const updated = setMemoryPinned(db, id, pinned === true)
      return { ok: !!updated }
    }
  )

  ipcMain.handle('salesBrain:memories:delete', async (_e, id: unknown): Promise<{ ok: boolean }> => {
    if (!isSalesBrainEnabled() || typeof id !== 'string') return { ok: false }
    const db = getMemoryDb()
    if (!db) return { ok: false }
    return { ok: deleteMemory(db, id) }
  })

  // Spec section 4: "Forget everything" with confirmation — the
  // confirmation dialog itself is the renderer's job (a native confirm or
  // a modal); this handler trusts that it was already shown, since a
  // second confirmation gate here would just be redundant, not safer.
  ipcMain.handle('salesBrain:memories:forgetEverything', async (): Promise<{ ok: boolean }> => {
    if (!isSalesBrainEnabled()) return { ok: false }
    const db = getMemoryDb()
    if (!db) return { ok: false }
    forgetEverything(db)
    return { ok: true }
  })

  ipcMain.handle(
    'salesBrain:memories:changelog',
    async (_e, scope: unknown): Promise<ReturnType<typeof buildChangelog>> => {
      if (!isSalesBrainEnabled()) return []
      const db = getMemoryDb()
      if (!db) return []
      return buildChangelog(db, typeof scope === 'string' ? (scope as MemoryScope) : undefined)
    }
  )

  // Spec section 4's post-call review: "Sales Brain learned N things from
  // this call — Review" → this returns exactly those memories, whichever
  // call triggered them.
  ipcMain.handle('salesBrain:memories:byCall', async (_e, callId: unknown): Promise<Memory[]> => {
    if (!isSalesBrainEnabled() || typeof callId !== 'string') return []
    const db = getMemoryDb()
    if (!db) return []
    return listMemoriesByCallId(db, callId)
  })

  // Spec section 4: "Per-call 'Don't learn from this call' toggle (pre-call
  // and retroactive)". This is the retroactive half — CallDetail.tsx's own
  // toggle. Turning it ON deletes any memories already extracted from this
  // call (the "leaves zero trace" testing requirement); turning it back
  // OFF does NOT retroactively re-run extraction — the rep can always
  // re-coach/re-save to trigger a fresh pass if they change their mind.
  ipcMain.handle(
    'salesBrain:calls:setExcluded',
    async (_e, callId: unknown, excluded: unknown): Promise<{ ok: boolean }> => {
      if (typeof callId !== 'string') return { ok: false }
      const updated = await setCallSalesBrainExcluded(callsDir(), callId, excluded === true)
      if (!updated) return { ok: false }

      if (excluded === true && isSalesBrainEnabled()) {
        const db = getMemoryDb()
        if (db) {
        // AUDIT FIX (2026-08-24) — evidence-level, not row-level. Deleting
        // every memory this source ever TOUCHED also destroyed what other
        // calls taught, because reinforcement stamps this source's callId
        // onto pre-existing rows. See forgetCallContribution.
          forgetCallContribution(db, callId)
        }
      }
      return { ok: true }
    }
  )

  ipcMain.handle('salesBrain:calls:getExcluded', async (_e, callId: unknown): Promise<boolean> => {
    if (typeof callId !== 'string') return false
    const call = await getCall(callsDir(), callId)
    return call?.salesBrainExcluded === true
  })
}
