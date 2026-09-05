import { useMemo } from 'react'
import { format, isSameDay, isToday } from 'date-fns'
import { PhoneCall, CalendarDays } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { ITEM_STYLES } from './items'
import type { CalendarEvent, CalendarItem } from './types'

interface AgendaRailProps {
  /** Every item the grid is currently showing, already context-enriched. */
  items: CalendarItem[]
  /** The visible range — inclusive start, inclusive end. */
  rangeStart: Date
  rangeEnd: Date
  onEditEvent: (event: CalendarEvent) => void
}

/**
 * M31 Slice B (3/3) — the agenda rail.
 *
 * The density escape valve identified in docs/M31-calendar-research.md §2.1:
 * no calendar app solves month-cell overflow, they route around it. Google
 * and Outlook both hard-cap the cell and offer "+N more"; the design-led apps
 * keep a complete chronological list beside the grid (Fantastical's sidebar,
 * Outlook's My Day) so the grid is ALLOWED to truncate without hiding
 * anything. This is that list.
 *
 * Two properties it must hold, or it isn't worth having:
 *   1. COMPLETE. It never truncates and never collapses — that is its whole
 *      job. If the grid says "+6 more", those six are here.
 *   2. Same truth as the chips. It reads the identical enriched CalendarItem
 *      the grid renders, so contact/deal/risk/brief/call context cannot
 *      disagree between the two views. It is a different presentation of one
 *      list, not a second list.
 */
export function AgendaRail({
  items,
  rangeStart,
  rangeEnd,
  onEditEvent
}: AgendaRailProps): React.JSX.Element {
  const days = useMemo(() => {
    const startMs = new Date(rangeStart).setHours(0, 0, 0, 0)
    const endMs = new Date(rangeEnd).setHours(23, 59, 59, 999)
    const inRange = items
      .filter((i) => i.end.getTime() >= startMs && i.start.getTime() <= endMs)
      .sort((a, b) => {
        // All-day first within a day, then by start — the same ordering the
        // grid's own sortForDay uses, so the two never disagree about order.
        const dayDiff =
          new Date(a.start).setHours(0, 0, 0, 0) - new Date(b.start).setHours(0, 0, 0, 0)
        if (dayDiff !== 0) return dayDiff
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
        return a.start.getTime() - b.start.getTime()
      })

    const grouped: { day: Date; items: CalendarItem[] }[] = []
    for (const item of inRange) {
      const last = grouped[grouped.length - 1]
      if (last && isSameDay(last.day, item.start)) last.items.push(item)
      else grouped.push({ day: item.start, items: [item] })
    }
    return grouped
  }, [items, rangeStart, rangeEnd])

  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-l border-line-soft pl-4">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-faint">Agenda</p>

      {days.length === 0 ? (
        <p className="flex items-center gap-2 text-[12px] text-faint">
          <CalendarDays className="h-3.5 w-3.5 shrink-0" />
          Nothing scheduled in this range.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {days.map(({ day, items: dayItems }) => (
            <div key={day.toISOString()}>
              <p
                className={cn(
                  'mb-1 text-[11px] font-medium',
                  isToday(day) ? 'text-accent' : 'text-muted'
                )}
              >
                {isToday(day) ? 'Today' : format(day, 'EEE d MMM')}
              </p>
              <div className="flex flex-col gap-1">
                {dayItems.map((item) => {
                  const editable = Boolean(item.event)
                  const ctx = item.context
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => {
                        if (editable && item.event) onEditEvent(item.event)
                      }}
                      className={cn(
                        'flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left transition',
                        editable ? 'hover:bg-elevated' : 'cursor-default'
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                          ITEM_STYLES[item.kind].dot
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[12px] text-ink">{item.title}</span>
                          {ctx?.callId && (
                            <PhoneCall aria-hidden className="h-3 w-3 shrink-0 text-faint" />
                          )}
                          {!ctx?.callId && ctx?.brief && (
                            <span
                              aria-hidden
                              className={cn(
                                'h-1.5 w-1.5 shrink-0 rounded-full',
                                ctx.brief === 'ready'
                                  ? 'bg-accent'
                                  : 'border border-current text-faint'
                              )}
                            />
                          )}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-faint">
                          <span>{item.allDay ? 'All day' : format(item.start, 'h:mm a')}</span>
                          {ctx?.contactName && <span>· {ctx.contactName}</span>}
                          {ctx?.dealStage && <span>· {ctx.dealStage}</span>}
                          {ctx?.risk && (
                            <span className={ctx.risk === 'high' ? 'text-danger' : 'text-warning'}>
                              · {ctx.risk} risk
                            </span>
                          )}
                          {ctx?.notSynced && (
                            <span className="text-warning" title={ctx.notSynced} data-testid="chip-not-synced">
                              · not on your calendar
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
