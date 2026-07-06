import type { CallSummary } from '@renderer/features/calls/types'
import { type Tone } from '@renderer/features/coaching/meta'

export interface ContactStats {
  callCount: number
  lastCallAt?: string
}

/** Group calls by their linked contact — the "so what" glance shown next to
 *  each contact (how many calls, how recently) without opening every one. */
export function buildContactStats(calls: CallSummary[]): Map<string, ContactStats> {
  const stats = new Map<string, ContactStats>()
  for (const call of calls) {
    if (!call.contactId) continue
    const existing = stats.get(call.contactId)
    if (!existing) {
      stats.set(call.contactId, { callCount: 1, lastCallAt: call.createdAt })
      continue
    }
    existing.callCount += 1
    if (call.createdAt > (existing.lastCallAt ?? '')) existing.lastCallAt = call.createdAt
  }
  return stats
}

const DAY_MS = 86_400_000

/** Green = recently in touch, amber = going quiet, rose = overdue for a follow-up. */
export function recencyTone(lastCallAt: string | undefined): Tone {
  if (!lastCallAt) return 'neutral'
  const days = (Date.now() - new Date(lastCallAt).getTime()) / DAY_MS
  if (days <= 14) return 'good'
  if (days <= 45) return 'mid'
  return 'low'
}

/** Compact "3d ago" / "2mo ago" — glanceable, not a full date. */
export function formatRelative(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS)
  if (days <= 0) return 'today'
  if (days === 1) return '1d ago'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}
