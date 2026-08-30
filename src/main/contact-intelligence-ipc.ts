// M23 Workstream D (+ follow-up) — IPC surface AND background trigger for
// Contact Intelligence: detecting the other party's name from a call
// transcript, and — in 'full-auto' mode — automatically creating/attaching
// a contact for it, with a visible native notification. Two entry points:
//
//   1. `contactIntelligence:detectName` IPC handler — the manual "Detect who
//      this was" button (Suggest mode) and the page-view-triggered effect
//      (Full-auto mode, CallDetail.tsx) both call this.
//   2. `runFullAutoContactIntelligence(callId)` — called fire-and-forget
//      from calls.ts, right after the SAME two points resolveAndSaveIdentities
//      already runs from, so full-auto mode completes end-to-end shortly
//      after a call is saved/coached WITHOUT the rep ever needing to open
//      the call's page.
//
// Both paths funnel through the same detectAndSaveIdentity() +
// maybeAutoCreateContact() pair, so behavior is identical regardless of
// which one ran. maybeAutoCreateContact() re-derives the call's current
// identity state rather than trusting a name/key passed in — this is
// deliberate: it also picks up an other-party identity resolved by the
// EXISTING M19 calendar/contact cascade (resolveAndSaveIdentities), which
// only ever writes speakerIdentities, never call.contactId, so full-auto
// mode auto-attaches for THAT signal too, not just this workstream's own
// self-intro/addressed-by-name detection.
//
// Gated throughout on: the contactIntelligence mode (the user-facing,
// discoverable opt-in), the EXISTING isSelfIntroExtractionAllowed() gate
// (the purpose-built opt-in for "buyer speech reaching a third-party LLM"),
// and the call's own per-call consent (call.consent.recordOtherParty),
// re-checked fresh from disk every time — never trusted from a stale
// snapshot, matching the M11 consent-retention invariant elsewhere in this
// codebase.
import { app, ipcMain, Notification, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { getCall, setCallContact, setSpeakerIdentity, speechSegments } from './calls-fs'
import { getContactIntelligenceMode, isSelfIntroExtractionAllowed } from './app-settings'
import { otherPartyKey, detectOtherPartyName } from './contact-intelligence'
import { createContact, findContactByName, getContact } from './contacts-fs'
import { getJobManager } from './jobs/instance'
import type { Job } from './jobs/types'

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}

function contactsDir(): string {
  return join(app.getPath('userData'), 'contacts')
}

// --- Serialize maybeAutoCreateContact's find-or-create step -------------
// A SEPARATE lock domain from calls-fs.ts's own internal per-call write
// lock (not reentrant into it — maybeAutoCreateContact calls
// setCallContact, which acquires that other lock itself; nesting the SAME
// lock here would deadlock).
//
// Keyed by the NORMALIZED CONTACT NAME, not callId — a per-call lock alone
// only stops two triggers for the SAME call (background hook + renderer
// page-view effect, both full-auto's real trigger paths) from racing each
// other. It does NOT stop two DIFFERENT calls that resolve to the same
// buyer name (e.g. two short calls with the same buyer, processed back to
// back) from each independently missing the other's not-yet-written
// contact and creating a duplicate — findContactByName has no lock of its
// own, so two concurrent lookups can both return "not found" before either
// write lands. Locking by name closes both races with one mechanism: two
// triggers for the same call always resolve to the same name (same lock
// key), and two different calls for the same buyer now serialize against
// each other too.
const autoCreateLocks = new Map<string, Promise<unknown>>()

function normalizeNameForLock(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

async function withAutoCreateLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = autoCreateLocks.get(lockKey) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  const settled = next.catch(() => {})
  autoCreateLocks.set(lockKey, settled)
  settled.then(() => {
    if (autoCreateLocks.get(lockKey) === settled) autoCreateLocks.delete(lockKey)
  })
  return next
}

export interface DetectNameResult {
  ok: boolean
  /** Present when detection ran and found a name (now saved). Absent (but
   *  ok:true) when detection ran cleanly and found nothing — not an error,
   *  the transcript just never made the other party's name clear. */
  name?: string
  message?: string
}

async function detectAndSaveIdentity(
  callId: string,
  opts?: { signal?: AbortSignal }
): Promise<DetectNameResult> {
  if (getContactIntelligenceMode() === 'off') {
    return { ok: false, message: 'Contact Intelligence is off — turn it on in Settings → CRM.' }
  }
  if (!isSelfIntroExtractionAllowed()) {
    return { ok: false, message: 'Self-intro detection is off in Settings.' }
  }

  const call = await getCall(callsDir(), callId)
  if (!call) return { ok: false, message: 'Call not found.' }
  if (call.consent?.recordOtherParty !== true) {
    return { ok: false, message: 'This call does not have consent to record the other party.' }
  }

  const lastRealSegment = [...call.segments].reverse().find((s) => s.kind !== 'gap')
  const multichannel = lastRealSegment ? lastRealSegment.channel !== undefined : false
  const repSpeaker = call.coaching?.metrics.repSpeaker ?? null

  // Gap markers (fabricated speaker:0, no channel) and unlabelled segments
  // must never count as a real observed speaker — otherwise a mono call
  // with a connectivity gap can look like 3+ parties and get wrongly
  // refused as "not one-on-one" even though it genuinely is.
  const cleanSegments = speechSegments(call.segments)

  const other = otherPartyKey({ segments: cleanSegments, multichannel, repSpeaker })
  if (!other) return { ok: false, message: 'This only works for a one-on-one call.' }

  if (call.speakerIdentities?.[other.key]?.name) {
    return { ok: false, message: 'Already known.' }
  }

  const name = await detectOtherPartyName(
    cleanSegments,
    other.speaker,
    other.repSpeaker,
    multichannel,
    { signal: opts?.signal }
  )
  if (!name) return { ok: true }

  // skipIfAlreadyResolved (not skipIfManual alone) — the AI call above can
  // take several seconds, during which the independent, fire-and-forget
  // naming cascade (resolve-for-call.ts) may have resolved a HIGHER-
  // confidence entry (a calendar/contact match) for this same key. This is
  // the lowest-priority source in the whole cascade, so it must never
  // clobber anything already resolved, not just a manual rename — checked
  // atomically here, not from the stale "already known" snapshot above.
  const updated = await setSpeakerIdentity(
    callsDir(),
    callId,
    other.key,
    { name, source: 'self-intro', confidence: 'medium' },
    { skipIfAlreadyResolved: true }
  )
  if (!updated) return { ok: false, message: 'Could not save the detected name.' }
  return { ok: true, name }
}

function notifyAutoAttached(contactName: string): void {
  const win = BrowserWindow.getAllWindows()[0]
  const notification = new Notification({
    title: 'Contact detected',
    body: `Automatically created and attached "${contactName}" from this call's transcript.`
  })
  if (win) {
    notification.on('click', () => {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
  }
  notification.show()
}

/** Full-auto mode's actual "complete my task" step: given whatever identity
 *  is now resolved for the other party (from THIS workstream's detection
 *  above, OR the pre-existing M19 calendar/contact cascade), create/link a
 *  contact and attach it to the call — no click required — then show a
 *  native notification so it's never silent. Safe to call unconditionally
 *  after any resolution attempt: it no-ops immediately outside full-auto
 *  mode, when the call already has a contact, or when nothing is resolved
 *  yet, so callers never need to guard the call themselves.
 *
 *  The actual find-or-create-and-attach step is wrapped in
 *  withAutoCreateLock, keyed by the resolved name (see that lock's own doc
 *  comment for why name, not callId) — this can legitimately race against
 *  another call for the same buyer, or another trigger for this same call
 *  (background hook + renderer page-view effect), and the lock plus a
 *  fresh re-read of the call INSIDE it (rather than trusting the snapshot
 *  taken before the lock was acquired) closes both races. */
export async function maybeAutoCreateContact(callId: string): Promise<void> {
  if (getContactIntelligenceMode() !== 'full-auto') return

  const call = await getCall(callsDir(), callId)
  if (!call || call.contactId) return
  if (call.consent?.recordOtherParty !== true) return

  const lastRealSegment = [...call.segments].reverse().find((s) => s.kind !== 'gap')
  const multichannel = lastRealSegment ? lastRealSegment.channel !== undefined : false
  const repSpeaker = call.coaching?.metrics.repSpeaker ?? null
  const cleanSegments = speechSegments(call.segments)

  const other = otherPartyKey({ segments: cleanSegments, multichannel, repSpeaker })
  if (!other) return

  const identity = call.speakerIdentities?.[other.key]
  if (!identity?.name) return

  const lockKey = normalizeNameForLock(identity.name)
  const attachedName = await withAutoCreateLock(lockKey, async () => {
    // Re-read fresh, INSIDE the lock: another invocation for this same
    // call (or, if this call's identity happened to change between reads,
    // a differently-keyed concurrent invocation) may have already attached
    // a contact while this one waited — the pre-lock `call` snapshot above
    // can't see that write.
    const fresh = await getCall(callsDir(), callId)
    if (!fresh || fresh.contactId) return null

    let contactId: string | null = null
    if (identity.contactId) {
      const existing = await getContact(contactsDir(), identity.contactId)
      if (existing) contactId = existing.id
    }
    if (!contactId) {
      const existing = await findContactByName(contactsDir(), identity.name)
      if (existing) {
        contactId = existing.id
      } else {
        const created = await createContact(contactsDir(), { name: identity.name })
        if (created) contactId = created.id
      }
    }
    if (!contactId) return null

    const linked = await setCallContact(callsDir(), callId, contactId)
    return linked ? identity.name : null
  })

  if (attachedName) notifyAutoAttached(attachedName)
}

/** Fire-and-forget from calls.ts, right after resolveAndSaveIdentities(), so
 *  full-auto mode completes end-to-end without the rep ever opening the
 *  call's page. Errors are swallowed by the caller, same as
 *  resolveAndSaveIdentities' own call sites — this must never block a call
 *  save or a coaching run. */
/** BUG-060 — `opts.signal` is what makes this job's Cancel button real.
 *  maybeAutoCreateContact does no AI call, so it doesn't need it. */
export async function runFullAutoContactIntelligence(
  callId: string,
  opts?: { signal?: AbortSignal }
): Promise<void> {
  await detectAndSaveIdentity(callId, { signal: opts?.signal }).catch(() => {})
  await maybeAutoCreateContact(callId).catch(() => {})
}

let registered = false

/** M26 Phase 3 — the manual "Detect who this was" button's job. */
const DETECT_JOB_TYPE = 'contactIntelligence:detectName'

export function registerContactIntelligence(): void {
  if (registered) return
  registered = true

  // ==========================================================================
  // WHY THIS JOB MUST STAY `kind: 'inline-async'` — DO NOT CHANGE TO 'worker'
  // ==========================================================================
  // This looks like an obvious candidate to move onto a worker thread "for
  // free parallelism". It is not, and doing so would silently corrupt the
  // AUTOMATIC path (runFullAutoContactIntelligence, fired twice per call from
  // calls.ts) — not this one.
  //
  // The manual button and the automatic hook are not merely similar: they
  // call the SAME two functions, detectAndSaveIdentity() and
  // maybeAutoCreateContact(). Those are made safe against each other by two
  // plain in-process JavaScript Maps:
  //
  //   * autoCreateLocks (this file, keyed by normalized contact NAME) — stops
  //     two concurrent resolutions of the same buyer from both seeing
  //     findContactByName() miss and both calling createContact(), which
  //     would produce DUPLICATE CONTACTS.
  //   * callLocks (calls-fs.ts) — serializes read-modify-write on a call file,
  //     so two writers can't clobber each other's speakerIdentities/contactId.
  //
  // A 'worker' executor runs in a separate V8 isolate with its OWN module
  // instances, hence its OWN copies of both Maps. They would still *appear*
  // to work — every lock acquisition succeeds instantly — while guarding
  // nothing at all across the two realms. The failure is silent, data-level,
  // and would show up as occasional duplicate contacts and lost identity
  // writes that no test in this file would catch.
  //
  // Verified by a shared-code-path audit (M26 Phase 3) and locked in by
  // explicit founder decision. If a future change genuinely needs this off
  // the main thread, the locks have to become cross-realm FIRST (a real
  // design change), not as a side effect of switching executor kinds.
  // ==========================================================================
  getJobManager().registerType<{ callId: string }, DetectNameResult>({
    type: DETECT_JOB_TYPE,
    lane: 'INTERACTIVE',
    titleFor: () => 'Detecting who this was',
    targetRefFor: (i) => i.callId,
    targetKind: 'call',
    // This feature already fires its own, far more useful notification when
    // it actually attaches someone (notifyAutoAttached: "Automatically
    // created and attached 'Dana'"). Without this flag, migrating it to a
    // job would produce TWO OS notifications for one auto-attach — the
    // feature's, plus a generic "Detecting who this was — done".
    silent: true,
    // BUG-060 — earned: handle.signal is threaded through
    // detectAndSaveIdentity -> detectOtherPartyName -> completeWithFallback.
    cancellable: true,
    executor: {
      kind: 'inline-async',
      run: async (input, handle) => {
        const result = await detectAndSaveIdentity(input.callId, { signal: handle.signal })
        if (result.ok && result.name) {
          await maybeAutoCreateContact(input.callId).catch(() => {})
        }
        // Resolves with the full DetectNameResult rather than throwing on
        // !ok: "ran cleanly and found nothing" and "refused because a gate
        // is off" are both legitimate non-error outcomes the button has
        // distinct wording for, and collapsing them into a job failure
        // would lose that. A genuine crash still rejects normally.
        return result
      }
    }
  })

  ipcMain.handle(
    'contactIntelligence:detectName',
    async (_e, callId: string): Promise<{ ok: boolean; jobId?: string }> => {
      const manager = getJobManager()
      // Dedupe per call: without this, repeated clicks (or CallDetail
      // remounting under full-auto mode) queue N jobs and fire N concurrent
      // AI calls — autoCreateLocks does NOT cover detectOtherPartyName.
      const already = manager
        .list()
        .find(
          (j: Job) =>
            j.type === DETECT_JOB_TYPE &&
            j.targetRef === callId &&
            (j.state === 'running' || j.state === 'queued')
        )
      if (already) return { ok: true, jobId: already.id }
      const job = manager.enqueue(DETECT_JOB_TYPE, { callId })
      return { ok: true, jobId: job.id }
    }
  )
}
