/**
 * M39 Stage 3 — assemble the client dossier ONCE per call, then hand out the
 * same string to every cue.
 *
 * WHY A STORE AND NOT A FUNCTION CALL PER CUE. Two reasons, and the second is
 * the one that matters:
 *   - cost. A cue fires every few seconds for the length of a call. Reading the
 *     whole calls directory each time would put an unbounded fan-out on the
 *     hot path (BUG-248: every record store reads its whole directory in one
 *     Promise.all behind libuv's 4-thread pool, so one listCalls blocks every
 *     other fs op in the process).
 *   - STABILITY. Prompt caching pays only on a byte-identical prefix. Rebuilding
 *     per cue would re-read records that a background job may have rewritten
 *     mid-call — BUG-185 restamps every call file on every sync cycle — so the
 *     prefix could change under a live call for reasons having nothing to do
 *     with the conversation. Assembling once freezes it for the call's life,
 *     the same choice `useLiveDealFacts` already makes for the deal facts line.
 *
 * FAILURE IS SILENCE, NEVER AN ERROR. Every path here returns '' rather than
 * throwing: a cue that cannot be given because a dossier could not be read is
 * strictly worse than a cue without one.
 */
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { buildClientDossier, type DossierCall, type DossierContact, type DossierDeal, type DossierTask } from './clientDossier'
import type { MinedObjection } from './objectionPreload'

/** One entry per live call. Cleared when the call ends. */
const cache = new Map<string, { contactId: string; text: string }>()

async function readDir<T>(dir: string): Promise<T[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: T[] = []
  // Serial, deliberately. This runs once at call start, off the cue path, and
  // BUG-248's finding was that a whole-directory Promise.all starves the
  // 4-thread pool for everything else in the process — including the journal
  // writes happening on this very call.
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      out.push(JSON.parse(await fs.readFile(join(dir, name), 'utf8')) as T)
    } catch {
      /* one unreadable record must not cost the whole dossier */
    }
  }
  return out
}

/**
 * Resolve a deal's stageId to the label the rep actually sees in the pipeline.
 *
 * READ FROM `userDataDir`, NOT VIA `loadDealStages()`. The app's own reader
 * resolves through `app.getPath('userData')` — the same directory at the one
 * production call site — but everything else this module reads comes from the
 * dir it was handed, and a stage list from one profile pasted onto records
 * from another is exactly the kind of divergence that is invisible once it is
 * inside a prompt. It also keeps this module free of electron (and, through
 * deal-stages.ts, of backup.ts and deals-fs.ts) so it stays testable.
 *
 * No sanitizer is duplicated here, deliberately: the builder already runs
 * `clean(stageLabel, 40)`, which collapses whitespace and truncates, so the
 * only work left is the id lookup and a type check.
 *
 * WHY THIS EXISTS AT ALL: it was missing. `stageLabel: null` was hard-coded
 * here while `m39-dossier-measure.ts` resolved the label properly, so the
 * MEASURED dossier read "stage: Went quiet" and the one the product actually
 * sends carried no stage at all. Two instruments, and the richer one was not
 * the product — the same shape as the `!t.done` bug, one level up.
 */
async function readStageLabel(userDataDir: string, stageId?: string): Promise<string | null> {
  if (!stageId) return null
  try {
    const raw = JSON.parse(await fs.readFile(join(userDataDir, 'deal-stages.json'), 'utf8'))
    const list: unknown = Array.isArray(raw) ? raw : raw?.stages
    if (!Array.isArray(list)) return null
    const found = list.find((s) => s && (s as { id?: unknown }).id === stageId) as
      | { label?: unknown }
      | undefined
    return typeof found?.label === 'string' && found.label.trim() ? found.label : null
  } catch {
    return null
  }
}

/**
 * Build and remember the dossier for this call. Safe to call repeatedly: the
 * second call for the same (callId, contactId) is a no-op, so the renderer can
 * send it on every cue without thinking about it.
 */
export async function ensureDossier(
  userDataDir: string,
  callId: string,
  contactId: string
): Promise<string> {
  const held = cache.get(callId)
  if (held && held.contactId === contactId) return held.text
  try {
    const contacts = await readDir<DossierContact>(join(userDataDir, 'contacts'))
    const contact = contacts.find((c) => c.id === contactId)
    if (!contact) {
      cache.set(callId, { contactId, text: '' })
      return ''
    }
    const [calls, tasks, deals, objections] = await Promise.all([
      readDir<DossierCall>(join(userDataDir, 'calls')),
      readDir<DossierTask>(join(userDataDir, 'tasks')),
      readDir<DossierDeal>(join(userDataDir, 'deals')),
      readDir<MinedObjection>(join(userDataDir, 'objection-queue'))
    ])
    const deal = deals.find((d) => d.contactId === contactId) ?? null
    const stageLabel = await readStageLabel(userDataDir, deal?.stageId)
    // `asOf` is read HERE and nowhere deeper: the dossier is assembled once
    // and frozen, so this is the one moment a clock may be consulted. Reading
    // it inside the builder would make "overdue" differ between two cues on
    // the same call and cost the cached prefix.
    const { text } = buildClientDossier({
      contact,
      deal,
      stageLabel,
      calls,
      tasks,
      objections,
      asOf: new Date().toISOString()
    })
    cache.set(callId, { contactId, text })
    return text
  } catch {
    cache.set(callId, { contactId, text: '' })
    return ''
  }
}

/** The frozen dossier for this call, or '' if none was assembled. */
export function getDossier(callId: string | undefined): string {
  if (!callId) return ''
  return cache.get(callId)?.text ?? ''
}

/** Called when a call ends. Also bounded defensively: a process that somehow
 *  never sees an end must not grow a map forever. */
export function clearDossier(callId?: string): void {
  if (callId) {
    cache.delete(callId)
    return
  }
  cache.clear()
}

/** Test seam — how many calls are being held. */
export function dossierCacheSize(): number {
  return cache.size
}
