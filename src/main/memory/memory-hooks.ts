// M25 Sales Brain — the actual fire-and-forget entry points calls.ts and
// coaching-chat-ipc.ts call after a call is saved/coached and after each
// coaching-chat message, respectively. Ties extraction (extraction.ts) +
// consolidation (consolidation.ts) together, gated on the master flag
// throughout — every function here is a safe no-op when Sales Brain is
// off, so callers never need their own gate check.
import { app, BrowserWindow, Notification } from 'electron'
import { join } from 'node:path'
import { getCall } from '../calls-fs'
import { isSalesBrainEnabled } from '../app-settings'
import { getMemoryDb } from './memory-runtime'
import { extractMemoriesFromCall, extractMemoriesFromChatMessage } from './extraction'
import { consolidateNewCandidate, runLightConsolidation } from './consolidation'
import type { MemoryScope } from './types'

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}

/** Spec section 4: "Post-call toast: 'Sales Brain learned N things from
 *  this call — Review'". Same native-notification pattern as alerts.ts/
 *  contact-intelligence-ipc.ts's notifyAutoAttached — clicking it focuses
 *  the window and deep-links to that call's review screen (the renderer
 *  listens for 'salesBrain:reviewRequested', same shape as prepBrief's own
 *  'prepBrief:openRequested' deep-link event). Never fires for zero new
 *  memories — "learned nothing" isn't worth an interruption. */
function notifyLearnedFromCall(callId: string, newCount: number): void {
  if (newCount === 0) return
  const win = BrowserWindow.getAllWindows()[0]
  const notification = new Notification({
    title: 'Sales Brain learned something',
    body: `Learned ${newCount} thing${newCount === 1 ? '' : 's'} from this call — click to review.`
  })
  if (win) {
    notification.on('click', () => {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('salesBrain:reviewRequested', callId)
    })
  }
  notification.show()
}

/**
 * Which of the two per-call extraction passes this is. Extraction runs twice
 * — once after a call is saved, once after it's coached — and the pass
 * decides whether CLIENT-scoped memories (facts about the buyer, filed under
 * their contact) may be stored at all.
 *
 * THE RULE, stated deliberately rather than left to emerge from timing:
 * **the post-save pass never stores client-scoped memories, full stop.**
 * Only the post-coach pass does.
 *
 * That used to be true only by accident. The post-save pass would read the
 * call's contactId before the contact-detection cascade (which needs an AI
 * round trip) had written one, see null, and drop client candidates as a
 * side effect of losing a race. Two problems with relying on that: it
 * silently reverses the moment extraction runs behind a queue instead of
 * inline, and it was never even reliably true — a call already linked to a
 * contact at save time DID store client memories on the first pass.
 *
 * Making it explicit means the guarantee is a property of the code rather
 * than of which network call happens to finish first, and it survives any
 * queue latency. The founder chose the strict form ("no client data before
 * coaching, no exceptions") over preserving the pre-linked case, because a
 * privacy rule that states in one sentence with no caveat is worth more
 * than the marginal extra data.
 *
 * `contactIdAtTrigger` on the post-coach pass is frozen at the moment the
 * trigger fired, for the same reason: if the buyer is identified while the
 * job sits in a queue, the job must still store what it would have stored
 * had it run immediately, not more.
 */
export type MemoryExtractionPass =
  { pass: 'post-save' } | { pass: 'post-coach'; contactIdAtTrigger: string | null }

/** Called fire-and-forget from calls.ts, same chain as
 *  runFullAutoContactIntelligence — after a call is saved AND after it's
 *  coached. Each candidate goes through consolidateNewCandidate() (Phase 2:
 *  exact-match reinforce → vector-similarity + smart-model merge check →
 *  contradiction check → insert), then every touched scope gets a light
 *  consolidation pass (promotion + profile recompile — see
 *  consolidation.ts's runLightConsolidation doc comment for why this is
 *  cheap enough to run synchronously here rather than deferred to the
 *  nightly pass).
 *
 *  The gates below (Sales Brain enabled, call not excluded) are read FRESH
 *  every time, deliberately NOT snapshotted alongside the contactId: they
 *  are permissions, not scope. If the rep turns Sales Brain off or excludes
 *  this call while a job waits in a queue, "I turned that off" has to
 *  actually stop it — a frozen permission check would silently break that
 *  promise, the same way the M11 consent invariants are always re-read
 *  rather than trusted from a snapshot. */
export async function runMemoryExtractionForCall(
  callId: string,
  pass: MemoryExtractionPass
): Promise<void> {
  if (!isSalesBrainEnabled()) return
  const db = getMemoryDb()
  if (!db) return

  const call = await getCall(callsDir(), callId)
  if (!call || call.salesBrainExcluded) return

  // null here is what makes extraction drop every client-scoped candidate
  // (see verifyAndBuild's `expectedKind === 'client' && !contactId` guard in
  // extraction.ts) — the post-save pass passes null unconditionally, never
  // reading the call's actual contactId at all.
  const contactId = pass.pass === 'post-save' ? null : pass.contactIdAtTrigger
  const candidates = await extractMemoriesFromCall(call.segments, callId, contactId)
  const touchedScopes = new Set<MemoryScope>()
  let newCount = 0
  for (const candidate of candidates) {
    const outcome = await consolidateNewCandidate(db, candidate)
    if (outcome === 'created') newCount++
    touchedScopes.add(candidate.scope)
  }
  for (const scope of touchedScopes) {
    await runLightConsolidation(db, scope)
  }
  notifyLearnedFromCall(callId, newCount)
}

/** Called fire-and-forget from coaching-chat-ipc.ts after each chat turn is
 *  saved (per-message extraction — see extraction.ts's own doc comment for
 *  why there's no "session end" hook to use instead). Same consolidation
 *  path as runMemoryExtractionForCall above. */
export async function runMemoryExtractionForChatMessage(
  callId: string,
  chatMessageId: string,
  message: string
): Promise<void> {
  if (!isSalesBrainEnabled()) return
  const db = getMemoryDb()
  if (!db) return

  const call = await getCall(callsDir(), callId)
  if (!call || call.salesBrainExcluded) return

  const candidates = await extractMemoriesFromChatMessage(
    message,
    callId,
    chatMessageId,
    call.contactId ?? null
  )
  const touchedScopes = new Set<MemoryScope>()
  for (const candidate of candidates) {
    await consolidateNewCandidate(db, candidate)
    touchedScopes.add(candidate.scope)
  }
  for (const scope of touchedScopes) {
    await runLightConsolidation(db, scope)
  }
}
