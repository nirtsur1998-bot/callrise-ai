// M23 Workstream D — IPC surface for the post-hoc "Detect who this was"
// action on the Call Detail page. Gated on: the new contactIntelligence mode
// (the user-facing, discoverable opt-in for this specific capability), the
// EXISTING isSelfIntroExtractionAllowed() gate (the purpose-built,
// already-established opt-in for "buyer speech reaching a third-party LLM
// for self-intro extraction" — this is the SAME category of action the live
// self-intro path already gates on, so it must be respected here too, not
// bypassed just because it has no renderer UI of its own today; the
// Contact Intelligence toggle's own settings handler keeps it in sync, see
// CrmSection.tsx), and the call's own per-call consent, same as the
// existing live self-intro persistence path in calls.ts.
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { getCall, setSpeakerIdentity, speechSegments } from './calls-fs'
import { getContactIntelligenceMode, isSelfIntroExtractionAllowed } from './app-settings'
import { otherPartyKey, detectOtherPartyName } from './contact-intelligence'

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}

export interface DetectNameResult {
  ok: boolean
  /** Present when detection ran and found a name (now saved). Absent (but
   *  ok:true) when detection ran cleanly and found nothing — not an error,
   *  the rep just never explicitly said their name. */
  name?: string
  message?: string
}

async function handleDetectName(callId: string): Promise<DetectNameResult> {
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

  const name = await detectOtherPartyName(cleanSegments, other.speaker, multichannel)
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

let registered = false

export function registerContactIntelligence(): void {
  if (registered) return
  registered = true

  ipcMain.handle('contactIntelligence:detectName', async (_e, callId: string): Promise<DetectNameResult> => {
    try {
      return await handleDetectName(callId)
    } catch {
      return { ok: false, message: 'Something went wrong. Please try again.' }
    }
  })
}
