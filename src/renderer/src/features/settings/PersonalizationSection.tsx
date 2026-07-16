import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { cn } from '@renderer/lib/cn'
import { fieldClass } from '@renderer/components/field'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { useAppSettings, type AppSettings } from './useAppSettings'
import { usePersonalizationPreview } from './usePersonalizationPreview'

type Pronoun = AppSettings['personalization']['pronoun']

const PRONOUNS: { id: Pronoun; label: string }[] = [
  { id: '', label: 'Skip' },
  { id: 'he', label: 'He/him' },
  { id: 'she', label: 'She/her' },
  { id: 'they', label: 'They/them' }
]

const MAX_NAME = 100
const MAX_ROLE = 150
const MAX_ABOUT = 1500

export function PersonalizationSection(): React.JSX.Element {
  const { settings, loading, update } = useAppSettings()
  const p = settings.personalization

  const [name, setName] = useState(p.name)
  const [role, setRole] = useState(p.role)
  const [about, setAbout] = useState(p.about)

  // Keep local drafts in sync once the real saved values arrive (they start
  // as the safe empty default until the first load resolves). One effect PER
  // FIELD — a single combined effect reset ALL drafts whenever ANY field's
  // save resolved, wiping text the user was mid-typing in another field.
  /* eslint-disable react-hooks/set-state-in-effect -- sync of edit drafts when the async-loaded settings arrive */
  useEffect(() => {
    setName(p.name)
  }, [p.name])
  useEffect(() => {
    setRole(p.role)
  }, [p.role])
  useEffect(() => {
    setAbout(p.about)
  }, [p.about])
  /* eslint-enable react-hooks/set-state-in-effect */

  const [expanded, setExpanded] = useState(false)
  const { preview } = usePersonalizationPreview(p)

  // Transient "Saved" labels next to each blur-committed field, auto-clearing
  // after ~2s — presentational only, mirrors CrmSection's "Cleared." pattern.
  const [savedField, setSavedField] = useState<'name' | 'role' | 'about' | null>(null)
  const savedTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flashSaved = (field: 'name' | 'role' | 'about'): void => {
    setSavedField(field)
    clearTimeout(savedTimeout.current)
    savedTimeout.current = setTimeout(() => setSavedField(null), 2000)
  }
  useEffect(() => () => clearTimeout(savedTimeout.current), [])

  const commitName = (): void => {
    if (name !== p.name) {
      void update({ personalization: { name } })
      flashSaved('name')
    }
  }
  const commitRole = (): void => {
    if (role !== p.role) {
      void update({ personalization: { role } })
      flashSaved('role')
    }
  }
  const commitAbout = (): void => {
    if (about !== p.about) {
      void update({ personalization: { about } })
      flashSaved('about')
    }
  }
  const setPronoun = (pronoun: Pronoun): void => {
    void update({ personalization: { pronoun } })
  }

  return (
    <>
      <Card className="mb-5">
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 flex items-center gap-2 text-[13px] font-medium text-muted">
              Your name
              {savedField === 'name' && <span className="text-[12px] text-positive">Saved</span>}
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              disabled={loading}
              maxLength={MAX_NAME}
              placeholder="e.g. Alex Rivera"
              className={fieldClass}
            />
          </div>
          <div>
            <label className="mb-1.5 flex items-center gap-2 text-[13px] font-medium text-muted">
              Your role
              {savedField === 'role' && <span className="text-[12px] text-positive">Saved</span>}
            </label>
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              onBlur={commitRole}
              disabled={loading}
              maxLength={MAX_ROLE}
              placeholder="e.g. Account Executive at Acme Co"
              className={fieldClass}
            />
          </div>
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-muted">
              Preferred pronoun for summaries
            </p>
            <SegmentedControl
              options={PRONOUNS.map((o) => ({ id: o.id, label: o.label }))}
              value={p.pronoun}
              onChange={setPronoun}
              disabled={loading}
            />
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-[13px] font-medium text-muted">
                About your sales role / what you sell / your style
                {savedField === 'about' && <span className="text-[12px] text-positive">Saved</span>}
              </label>
            </div>
            <textarea
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              onBlur={commitAbout}
              disabled={loading}
              maxLength={MAX_ABOUT}
              rows={4}
              placeholder="e.g. I sell mid-market SaaS deals, usually 3-6 month cycles, and I lead with ROI over feature lists."
              className={cn(fieldClass, 'resize-y')}
            />
            <p
              className={cn(
                'mt-1 text-right text-[11px]',
                about.length >= MAX_ABOUT * 0.9 ? 'text-warning' : 'text-faint'
              )}
            >
              {about.length}/{MAX_ABOUT}
            </p>
          </div>
        </div>
      </Card>

      <Card className="mb-5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <div className="min-w-0">
            <p className="text-[13px] font-medium">
              What the AI sees:{' '}
              <span className="text-muted">
                {preview ? `${preview.charCount.toLocaleString()} characters` : '—'}
              </span>
            </p>
            <p className="mt-0.5 text-[12px] text-muted">
              {preview && preview.charCount === 0
                ? "Nothing yet — fill in a field above and it'll appear here."
                : 'Added to every summary and coaching request.'}
            </p>
          </div>
          {preview && preview.charCount > 0 && (
            <span className="shrink-0 text-faint">
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </span>
          )}
        </button>
        {expanded && preview && preview.charCount > 0 && (
          <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-line-soft bg-canvas px-3 py-2.5 text-[12px] leading-relaxed whitespace-pre-wrap text-muted">
            {preview.text}
          </pre>
        )}
      </Card>
    </>
  )
}
