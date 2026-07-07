// Routes the generic push/pull calls events.ts makes to whichever calendar
// provider (Google or Outlook) an event is actually linked to — or, for a
// brand-new unlinked event, whichever ONE provider currently has two-way sync
// enabled. Only one provider is ever expected to be connected in read-write
// mode at a time; if an event is already linked to a specific provider, that
// link always wins over "the active one" so a provider switch can't silently
// redirect an existing event's pushes.
import {
  isGoogleSyncEnabled,
  pushInsertEvent as googlePushInsertEvent,
  pushUpdateEvent as googlePushUpdateEvent,
  pushDeleteEvent as googlePushDeleteEvent,
  dropCachedEvent as googleDropCachedEvent
} from './google'
import {
  isOutlookSyncEnabled,
  pushInsertEvent as outlookPushInsertEvent,
  pushUpdateEvent as outlookPushUpdateEvent,
  pushDeleteEvent as outlookPushDeleteEvent,
  dropCachedEvent as outlookDropCachedEvent
} from './outlook'
import type { PushResult, DeleteResult } from './google-sync'
import type { CalendarEvent } from './events-fs'

export type ProviderKind = 'google' | 'outlook'

export function providerKindOf(provider?: string): ProviderKind | null {
  if (provider?.startsWith('google:')) return 'google'
  if (provider?.startsWith('outlook:')) return 'outlook'
  return null
}

async function isSyncEnabledFor(kind: ProviderKind): Promise<boolean> {
  return kind === 'google' ? isGoogleSyncEnabled() : isOutlookSyncEnabled()
}

/** Whichever ONE provider is currently enabled for two-way sync, checked in a
 *  stable order — meaningful only for brand-new, never-linked events. */
async function activeProviderKind(): Promise<ProviderKind | null> {
  if (await isGoogleSyncEnabled()) return 'google'
  if (await isOutlookSyncEnabled()) return 'outlook'
  return null
}

/** The generic "is sync on at all" gate events.ts uses before doing any push
 *  bookkeeping — provider-agnostic on purpose. */
export async function isAnySyncEnabled(): Promise<boolean> {
  return (await activeProviderKind()) !== null
}

export async function pushInsertEvent(ev: CalendarEvent): Promise<PushResult> {
  const kind = await activeProviderKind()
  if (kind === 'google') return googlePushInsertEvent(ev)
  if (kind === 'outlook') return outlookPushInsertEvent(ev)
  return { ok: false, error: 'not-enabled', retryable: false }
}

export async function pushUpdateEvent(ev: CalendarEvent): Promise<PushResult> {
  const kind = ev.provider ? providerKindOf(ev.provider) : await activeProviderKind()
  if (kind && !(await isSyncEnabledFor(kind)))
    return { ok: false, error: 'not-enabled', retryable: false }
  if (kind === 'google') return googlePushUpdateEvent(ev)
  if (kind === 'outlook') return outlookPushUpdateEvent(ev)
  return { ok: false, error: 'not-enabled', retryable: false }
}

export async function pushDeleteEvent(
  externalId: string,
  provider?: string
): Promise<DeleteResult> {
  const kind = providerKindOf(provider) ?? (await activeProviderKind())
  if (kind === 'google') return googlePushDeleteEvent(externalId, provider)
  if (kind === 'outlook') return outlookPushDeleteEvent(externalId, provider)
  return { ok: false, error: 'not-enabled', retryable: false }
}

export async function dropCachedEvent(externalId: string, provider?: string): Promise<void> {
  const kind = providerKindOf(provider)
  if (kind === 'google') return googleDropCachedEvent(externalId, provider)
  if (kind === 'outlook') return outlookDropCachedEvent(externalId, provider)
}
