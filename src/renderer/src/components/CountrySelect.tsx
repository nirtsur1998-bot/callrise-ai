import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { COUNTRIES, flagEmoji, type Country } from '@renderer/lib/countries'
import { cn } from '@renderer/lib/cn'

interface CountrySelectProps {
  /** ISO 3166-1 alpha-2 code, or undefined for "no selection". */
  value: string | undefined
  onChange: (code: string | undefined) => void
  /** 'country' shows the country name on the trigger; 'phone' shows its dial code. */
  mode?: 'country' | 'phone'
  placeholder?: string
}

/** A searchable country dropdown with flags — used for "country of client" and
 *  the phone country-code picker (same list, different trigger label). */
export function CountrySelect({
  value,
  onChange,
  mode = 'country',
  placeholder = 'Select a country'
}: CountrySelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const selected = useMemo(() => COUNTRIES.find((c) => c.code === value), [value])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    // BUG-047: capture phase, not bubble — same fix, same reason, as
    // ContactPicker.tsx (see its own comment for the full explanation).
    // This picker is used inside the Add/Edit contact dialog, which sits
    // inside the same Modal.tsx whose panel stops mousedown from bubbling,
    // so a bubble-phase listener here never even saw a click on a
    // different field in the same dialog.
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open])

  useEffect(() => {
    if (open) {
      // Reset for this opening; the search box's own onChange drives it from here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery('')
      // Focus the search box once the popover has mounted.
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }, [open])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return COUNTRIES
    return COUNTRIES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.dial.replace('+', '').startsWith(q.replace('+', ''))
    )
  }, [query])

  const choose = (c: Country): void => {
    onChange(c.code)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink transition focus:border-accent focus:outline-none"
      >
        {selected ? (
          <span className="flex items-center gap-2 truncate">
            <span className="text-base leading-none">{flagEmoji(selected.code)}</span>
            <span className="truncate">{mode === 'phone' ? selected.dial : selected.name}</span>
          </span>
        ) : (
          <span className="truncate text-faint">{placeholder}</span>
        )}
        <ChevronDown className="h-4 w-4 shrink-0 text-faint" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1.5 w-full min-w-[240px] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl">
          <div className="relative border-b border-line-soft p-2">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search countries…"
              className="w-full rounded-lg bg-canvas py-1.5 pl-8 pr-2 text-sm text-ink placeholder:text-faint focus:outline-none"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {results.length === 0 ? (
              <p className="px-3 py-3 text-center text-[13px] text-faint">No matches.</p>
            ) : (
              results.map((c) => (
                <button
                  key={c.code}
                  type="button"
                  onClick={() => choose(c)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition hover:bg-elevated',
                    c.code === value && 'bg-accent-soft text-ink'
                  )}
                >
                  <span className="text-base leading-none">{flagEmoji(c.code)}</span>
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="shrink-0 text-[11px] text-faint">{c.dial}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
