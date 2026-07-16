import { useEffect, useRef, useState } from 'react'
import {
  startOfWeek,
  startOfDay,
  addDays,
  setHours,
  isToday,
  format,
  differenceInMinutes
} from 'date-fns'
import { cn } from '@renderer/lib/cn'
import type { CalendarEvent, CalendarItem } from './types'
import { ITEM_STYLES, itemsOnDay, layoutColumns, formatTime } from './items'

const HOUR_HEIGHT = 44 // px per hour
const DAY_HEIGHT = HOUR_HEIGHT * 24
const HOURS = Array.from({ length: 24 }, (_, h) => h)
const COLS = 'grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]'

interface WeekGridProps {
  cursor: Date
  items: CalendarItem[]
  onNewEvent: (start: Date) => void
  onEditEvent: (event: CalendarEvent) => void
}

/** Minutes from the start of `day`, clamped to the day's bounds. */
function minutesInto(d: Date, day: Date): number {
  return Math.max(0, Math.min(1440, differenceInMinutes(d, startOfDay(day))))
}

export function WeekGrid({
  cursor,
  items,
  onNewEvent,
  onEditEvent
}: WeekGridProps): React.JSX.Element {
  const weekStart = startOfWeek(cursor, { weekStartsOn: 0 })
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const scrollRef = useRef<HTMLDivElement>(null)
  const nowLineRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  // Open scrolled to center on the current time rather than a fixed hour.
  // This grid's own overflow-y-auto container isn't reliably the element
  // that actually scrolls (a parent in the flex chain isn't height-clamped,
  // so the page itself grows and scrolls instead) — scrollIntoView on the
  // now-line marker resolves whichever ancestor is truly scrollable, so it
  // works regardless of that layout quirk. Deferred a frame so the mount's
  // page-enter transition (MainApp's `.animate-view`) has already committed.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      nowLineRef.current?.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-line-soft">
      {/* Day headers */}
      <div className={cn(COLS, 'border-b border-line-soft')}>
        <div className="border-r border-line-soft" />
        {days.map((day) => {
          const today = isToday(day)
          return (
            <div
              key={day.toISOString()}
              className="flex items-center justify-center gap-1.5 border-r border-line-soft py-2 last:border-r-0"
            >
              <span className="text-[11px] uppercase tracking-wide text-faint">
                {format(day, 'EEE')}
              </span>
              <span
                className={cn(
                  'grid h-6 w-6 place-items-center rounded-full text-[12px]',
                  today ? 'bg-accent font-semibold text-white' : 'text-ink'
                )}
              >
                {format(day, 'd')}
              </span>
            </div>
          )
        })}
      </div>

      {/* All-day row (tasks + all-day events) */}
      <div className={cn(COLS, 'border-b border-line-soft')}>
        <div className="flex items-center justify-end border-r border-line-soft px-2 py-1 text-[10px] uppercase tracking-wide text-faint">
          All-day
        </div>
        {days.map((day) => {
          const allDay = itemsOnDay(items, day).filter((it) => it.allDay)
          return (
            <div
              key={day.toISOString()}
              className="min-h-[28px] space-y-0.5 border-r border-line-soft p-1 last:border-r-0"
            >
              {allDay.map((item) => {
                const editable = Boolean(item.event) // editable events open the dialog; tasks/read-only don't
                const title = item.subtitle ? `${item.title} · ${item.subtitle}` : item.title
                const className = cn(
                  'block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] leading-tight',
                  ITEM_STYLES[item.kind].chip,
                  item.done && 'line-through opacity-60',
                  editable ? 'hover:brightness-125' : 'cursor-default'
                )
                return editable ? (
                  <button
                    key={item.key}
                    type="button"
                    title={title}
                    onClick={() => {
                      if (item.event) onEditEvent(item.event)
                    }}
                    className={className}
                  >
                    {item.title}
                  </button>
                ) : (
                  <div key={item.key} title={title} className={className}>
                    {item.title}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {/* Scrollable time grid */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className={cn(COLS, 'relative')}>
          {/* Time axis */}
          <div className="relative border-r border-line-soft" style={{ height: DAY_HEIGHT }}>
            {HOURS.slice(1).map((h) => (
              <div
                key={h}
                className="absolute right-1.5 -translate-y-1/2 text-[10px] text-faint"
                style={{ top: h * HOUR_HEIGHT }}
              >
                {format(setHours(weekStart, h), 'h a')}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((day) => {
            const timed = itemsOnDay(items, day).filter((it) => !it.allDay)
            const laidOut = layoutColumns(timed)
            const today = isToday(day)
            return (
              <div
                key={day.toISOString()}
                className={cn(
                  'relative border-r border-line-soft last:border-r-0',
                  today && 'bg-accent/5'
                )}
                style={{ height: DAY_HEIGHT }}
              >
                {/* Hour cells (click to create) */}
                {HOURS.map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => onNewEvent(setHours(startOfDay(day), h))}
                    className="block w-full border-b border-line-soft/60 transition hover:bg-elevated/40"
                    style={{ height: HOUR_HEIGHT }}
                  />
                ))}

                {/* Live now-line */}
                {today && (
                  <div
                    ref={nowLineRef}
                    className="pointer-events-none absolute inset-x-0 z-10"
                    style={{ top: (minutesInto(now, day) / 60) * HOUR_HEIGHT }}
                  >
                    <div className="relative h-px bg-accent">
                      <span className="absolute -left-0.5 -top-[3px] h-1.5 w-1.5 rounded-full bg-accent" />
                    </div>
                  </div>
                )}

                {/* Timed blocks */}
                {laidOut.map(({ item, lane, lanes }) => {
                  const startMin = minutesInto(item.start, day)
                  const endMin = minutesInto(item.end, day)
                  const top = (startMin / 60) * HOUR_HEIGHT
                  const height = Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, 18)
                  const laneWidth = 100 / lanes
                  const editable = Boolean(item.event) // 'event' + adopted-editable 'google'
                  const style = ITEM_STYLES[item.kind]
                  return (
                    <button
                      key={item.key}
                      type="button"
                      title={item.subtitle ? `${item.title} · ${item.subtitle}` : item.title}
                      onClick={() => {
                        if (editable && item.event) onEditEvent(item.event)
                      }}
                      className={cn(
                        'absolute overflow-hidden rounded-md px-1.5 py-0.5 text-left text-[11px] leading-tight',
                        style.block,
                        editable ? 'cursor-pointer hover:brightness-110' : 'cursor-default'
                      )}
                      style={{
                        top,
                        height,
                        left: `calc(${lane * laneWidth}% + 2px)`,
                        width: `calc(${laneWidth}% - 4px)`
                      }}
                    >
                      <div className="truncate font-medium">{item.title}</div>
                      {height > 28 && (
                        <div className="truncate opacity-70">{formatTime(item.start)}</div>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
