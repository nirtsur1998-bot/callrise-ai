const DAY_MS = 24 * 60 * 60 * 1000

export type DueTone = 'overdue' | 'today' | 'soon' | 'later'

export interface DueLabel {
  text: string
  tone: DueTone
}

function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Whole calendar days from today to the given date (negative = in the past). */
export function dueDiffDays(iso: string): number {
  const due = new Date(iso)
  if (Number.isNaN(due.getTime())) return 0
  return Math.round((localMidnight(due) - localMidnight(new Date())) / DAY_MS)
}

/** A short absolute date like "Jul 6" (adds the year only if it isn't this year). */
export function formatShortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  })
}

/** A friendly, always-accurate due label, e.g. "In 3 days · Jul 6". */
export function formatDueLabel(iso?: string): DueLabel | null {
  if (!iso) return null
  const due = new Date(iso)
  if (Number.isNaN(due.getTime())) return null
  const diff = dueDiffDays(iso)
  const date = formatShortDate(iso)
  if (diff < 0) return { text: `Overdue · ${date}`, tone: 'overdue' }
  if (diff === 0) return { text: 'Today', tone: 'today' }
  if (diff === 1) return { text: 'Tomorrow', tone: 'soon' }
  if (diff <= 7) return { text: `In ${diff} days · ${date}`, tone: 'soon' }
  return { text: date, tone: 'later' }
}

export type DueBucket = 'overdue' | 'today' | 'soon' | 'later' | 'none'

/** Groups a due date into one of the buckets used to section the Open list. */
export function dueBucket(iso?: string): DueBucket {
  if (!iso) return 'none'
  const diff = dueDiffDays(iso)
  if (diff < 0) return 'overdue'
  if (diff === 0) return 'today'
  if (diff <= 7) return 'soon'
  return 'later'
}

/** Convert an ISO timestamp to the value a <input type="date"> expects (local). */
export function isoToDateInputValue(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Convert a <input type="date"> value (YYYY-MM-DD) to an ISO timestamp. */
export function dateInputValueToIso(ymd: string): string | undefined {
  if (!ymd) return undefined
  const [y, m, d] = ymd.split('-').map(Number)
  if (!y || !m || !d) return undefined
  // Anchor at local noon so the calendar day never shifts when re-displayed.
  const date = new Date(y, m - 1, d, 12, 0, 0, 0)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}
