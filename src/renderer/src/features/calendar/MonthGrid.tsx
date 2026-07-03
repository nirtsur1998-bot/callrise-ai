import { startOfMonth, startOfWeek, addDays, isSameMonth, isToday, format } from 'date-fns'
import { cn } from '@renderer/lib/cn'
import type { CalendarEvent, CalendarItem } from './types'
import { ITEM_STYLES, itemsOnDay, sortForDay } from './items'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MAX_VISIBLE = 3

interface MonthGridProps {
  cursor: Date
  items: CalendarItem[]
  onNewEvent: (day: Date) => void
  onEditEvent: (event: CalendarEvent) => void
  onZoomDay: (day: Date) => void
}

export function MonthGrid({
  cursor,
  items,
  onNewEvent,
  onEditEvent,
  onZoomDay
}: MonthGridProps): React.JSX.Element {
  // Always render a fixed 6-week (42-day) grid so the month never changes height.
  const gridStart = startOfWeek(startOfMonth(cursor), { weekStartsOn: 0 })
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))

  return (
    <div className="flex h-full flex-col">
      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b border-line-soft pb-2">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 text-[11px] font-medium uppercase tracking-wide text-faint">
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid flex-1 grid-cols-7 grid-rows-6 gap-px overflow-hidden bg-line-soft">
        {days.map((day) => {
          const dayItems = sortForDay(itemsOnDay(items, day))
          const visible = dayItems.slice(0, MAX_VISIBLE)
          const overflow = dayItems.length - visible.length
          const inMonth = isSameMonth(day, cursor)
          const today = isToday(day)

          return (
            <div
              key={day.toISOString()}
              onClick={() => onNewEvent(day)}
              className={cn(
                'group flex min-h-0 cursor-pointer flex-col gap-1 overflow-hidden p-1.5 transition',
                inMonth ? 'bg-canvas hover:bg-elevated/60' : 'bg-canvas/40'
              )}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onZoomDay(day)
                }}
                className={cn(
                  'grid h-6 w-6 shrink-0 place-items-center self-start rounded-full text-[12px] transition',
                  today
                    ? 'bg-accent font-semibold text-white'
                    : inMonth
                      ? 'text-muted hover:bg-elevated hover:text-ink'
                      : 'text-faint'
                )}
              >
                {format(day, 'd')}
              </button>

              <div className="flex min-h-0 flex-col gap-0.5 overflow-hidden">
                {visible.map((item) => (
                  <Chip key={item.key} item={item} onEditEvent={onEditEvent} />
                ))}
                {overflow > 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onZoomDay(day)
                    }}
                    className="px-1 text-left text-[11px] text-faint transition hover:text-muted"
                  >
                    +{overflow} more
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Chip({
  item,
  onEditEvent
}: {
  item: CalendarItem
  onEditEvent: (event: CalendarEvent) => void
}): React.JSX.Element {
  const style = ITEM_STYLES[item.kind]
  const editable = item.kind === 'event' && item.event
  return (
    <button
      type="button"
      title={item.subtitle ? `${item.title} · ${item.subtitle}` : item.title}
      onClick={(e) => {
        e.stopPropagation()
        if (editable && item.event) onEditEvent(item.event)
      }}
      className={cn(
        'flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] leading-tight transition',
        style.chip,
        item.done && 'line-through opacity-60',
        editable ? 'hover:brightness-125' : 'cursor-default'
      )}
    >
      {!item.allDay && <span className="shrink-0 opacity-70">{format(item.start, 'h:mm')}</span>}
      <span className="truncate">{item.title}</span>
    </button>
  )
}
