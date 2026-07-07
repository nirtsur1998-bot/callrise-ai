/**
 * Format a DATE-ONLY string ("2026-07-07") for display.
 *
 * `new Date('2026-07-07')` parses as UTC midnight, so formatting it with a
 * local-time formatter shows the PREVIOUS day for anyone west of UTC ("Jul 6"
 * for a stored Jul 7). Parsing the parts and building a local date avoids the
 * shift — a date-only value has no timezone; it should read back exactly as
 * the user picked it.
 */
export function formatDateOnly(value: string | undefined): string | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
