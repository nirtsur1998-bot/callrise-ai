// Wires resolveCascade() (pure logic) to real IO: the call's own segments,
// Settings → Personalization's name, and the Google/Outlook calendar caches.
// Called automatically at two points (see main/calls.ts and main/coach.ts):
//
//   1. Right after a call is saved — resolves fully for multichannel calls
//      (channel 0/1 are deterministic) and partially for mono calls (the
//      "me" side needs repSpeaker, which isn't known yet at save time).
//   2. Right after coaching finishes — CoachMetrics.repSpeaker is now known,
//      so a mono call's "me" key (and therefore its single-other-party
//      detection) can resolve for the first time.
//
// Never overwrites a 'manual' entry (a rep's own rename is the one thing
// nothing in this cascade may clobber).

import { getCall, setSpeakerIdentity, type Call } from '../calls-fs'
import { findContactByEmail } from '../contacts-fs'
import { loadAppSettings, isSpeakerIdEnabled } from '../app-settings'
import { getCachedGoogleEvents } from '../google'
import { getCachedOutlookEvents } from '../outlook'
import { resolveCascade, type ContactLookup } from './resolve'

interface Dirs {
  calls: string
  contacts: string
}

function contactLookup(contactsDir: string): ContactLookup {
  return {
    findByEmail: async (email: string) => {
      const contact = await findContactByEmail(contactsDir, email)
      return contact ? { id: contact.id, name: contact.name } : null
    }
  }
}

/** Re-resolves and saves speaker identities for one call. Safe to call
 *  repeatedly — re-running with the same inputs produces the same output,
 *  and a caller-supplied 'manual' entry is never touched. */
export async function resolveAndSaveIdentities(dirs: Dirs, callId: string): Promise<Call | null> {
  if (!isSpeakerIdEnabled()) return null
  const call = await getCall(dirs.calls, callId)
  if (!call) return null

  const multichannel = call.segments.some((s) => s.channel !== undefined)
  const repSpeaker = call.coaching?.metrics.repSpeaker ?? null
  const userName = loadAppSettings().personalization.name.trim() || null
  const callStart = new Date(call.createdAt).getTime()
  if (!Number.isFinite(callStart)) return call

  const [google, outlook] = await Promise.all([
    getCachedGoogleEvents().catch(() => []),
    getCachedOutlookEvents().catch(() => [])
  ])

  const resolved = await resolveCascade(
    {
      segments: call.segments,
      multichannel,
      repSpeaker,
      userName,
      call: { startedAtMs: callStart, durationMs: call.durationMs },
      calendarEvents: [...google, ...outlook]
    },
    contactLookup(dirs.contacts)
  )

  let latest: Call | null = call
  for (const [key, record] of Object.entries(resolved)) {
    const existing = call.speakerIdentities?.[key]
    if (existing?.source === 'manual') continue // never overwrite a rename
    if (existing?.name === record.name && existing?.source === record.source) continue // no-op, skip the write
    latest = await setSpeakerIdentity(dirs.calls, callId, key, record)
  }
  return latest
}
