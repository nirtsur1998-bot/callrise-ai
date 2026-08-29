import { useEffect, useRef, useState } from 'react'
import { startOfMonth, startOfWeek, addDays, isSameMonth, isToday, format } from 'date-fns'
import { Plus, PhoneCall } from 'lucide-react'
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

  const [peekDay, setPeekDay] = useState<string | null>(null)
  const peekRef = useRef<HTMLDivElement | null>(null)

  // Cursor changes (month navigation) should close any open peek popover.
  // Adjusting state during render (rather than in an effect) avoids an extra render pass.
  const [prevCursor, setPrevCursor] = useState(cursor)
  if (prevCursor !== cursor) {
    setPrevCursor(cursor)
    if (peekDay !== null) setPeekDay(null)
  }

  useEffect(() => {
    if (!peekDay) return
    const handleClick = (e: MouseEvent): void => {
      if (peekRef.current && !peekRef.current.contains(e.target as Node)) {
        setPeekDay(null)
      }
    }
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPeekDay(null)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [peekDay])

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
          const dayKey = format(day, 'yyyy-MM-dd')
          const isPeekOpen = peekDay === dayKey

          return (
            <div
              key={day.toISOString()}
              className={cn(
                'group relative flex min-h-0 flex-col gap-1 overflow-hidden p-1.5 transition',
                inMonth ? 'bg-canvas hover:bg-elevated/60' : 'bg-canvas/40',
                today && 'bg-accent/5'
              )}
            >
              {/* Fills the empty area of the cell; sits behind the date number
                  and chips so clicking them still opens/edits instead of
                  creating a new event. Keyboard-reachable via Tab. */}
              <button
                type="button"
                aria-label={`New event on ${format(day, 'MMMM d')}`}
                onClick={() => onNewEvent(day)}
                className="absolute inset-0 z-0 flex items-end justify-center pb-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <Plus className="h-3.5 w-3.5 text-faint" />
              </button>

              <div className="relative z-10 flex min-h-0 flex-col gap-1">
                <button
                  type="button"
                  aria-label={`Open ${format(day, 'MMMM d')}`}
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
                    <div className="relative" ref={isPeekOpen ? peekRef : undefined}>
                      <button
                        type="button"
                        aria-expanded={isPeekOpen}
                        onClick={(e) => {
                          e.stopPropagation()
                          setPeekDay(isPeekOpen ? null : dayKey)
                        }}
                        className="px-1 text-left text-[11px] text-faint transition hover:text-muted"
                      >
                        +{overflow} more
                      </button>

                      {isPeekOpen && (
                        <div className="animate-pop absolute left-0 top-full z-20 mt-1 w-64 rounded-xl border border-line bg-surface p-2 shadow-pop">
                          <div className="mb-1 px-1 text-[11px] font-medium text-muted">
                            {format(day, 'EEEE, MMM d')}
                          </div>
                          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                            {dayItems.map((item) => (
                              <Chip key={item.key} item={item} onEditEvent={onEditEvent} />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
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
  const editable = Boolean(item.event) // 'event' + adopted-editable 'google' items
  const ctx = item.context
  // M31 Slice B — the month cell is only ~3 chips tall, so context here is
  // deliberately two glyphs and the contact's name, never a second line: the
  // richer treatment belongs in the week view, where a block has height.
  // Everything is additive — a chip with no context renders exactly as before.
  const title = [
    item.title,
    ctx?.contactName && `with ${ctx.contactName}`,
    ctx?.dealStage && `${ctx.dealStage} stage`,
    ctx?.risk && `${ctx.risk} risk`,
    ctx?.brief === 'ready'
      ? 'prep brief ready'
      : ctx?.brief === 'outdated'
        ? 'prep brief needs refreshing'
        : undefined,
    // Says "recorded" rather than "recording": this marker means the call
    // happened and is saved, and the chip still opens the meeting — the call
    // is one clearly-labelled click further in, so a click never lands
    // somewhere the user didn't ask for.
    ctx?.callId && 'call recorded — open the meeting to view it',
    item.subtitle
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <button
      type="button"
      title={title}
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
      {ctx?.risk && (
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            ctx.risk === 'high' ? 'bg-danger' : 'bg-warning'
          )}
        />
      )}
      {/* The title stays the title. An earlier pass swapped in the contact
          name when one was linked, which reads well until two meetings with
          the same person become indistinguishable — the chip would be
          hiding what the meeting IS. Contact/stage live in the tooltip here
          and on their own line in the week view, where there's room. */}
      <span className="truncate">{item.title}</span>
      {ctx?.callId ? (
        // Outcome beats plan on the same chip: once a call exists, the brief
        // dot has nothing left to offer (the meeting already happened), so
        // only one marker is ever shown. A chip never carries both.
        <PhoneCall aria-hidden className="ml-auto h-2.5 w-2.5 shrink-0 opacity-70" />
      ) : (
        ctx?.brief && (
          <span
            aria-hidden
            className={cn(
              'ml-auto h-1.5 w-1.5 shrink-0 rounded-full',
              // 'outdated' is deliberately hollow, not a second solid colour:
              // it means "there is one, but opening it will rebuild it", which
              // is a weaker claim than 'ready' and should look like one.
              ctx.brief === 'ready' ? 'bg-accent' : 'border border-current opacity-60'
            )}
          />
        )
      )}
    </button>
  )
}
