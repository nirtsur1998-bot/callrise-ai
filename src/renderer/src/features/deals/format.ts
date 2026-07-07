import { formatDateOnly } from '@renderer/lib/dateOnly'

/** No multi-currency support yet — every value is formatted as USD. */
export function formatValue(value: number | undefined): string | null {
  if (value === undefined) return null
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(value)
}

export function formatCloseDate(value: string | undefined): string | null {
  return formatDateOnly(value)
}
