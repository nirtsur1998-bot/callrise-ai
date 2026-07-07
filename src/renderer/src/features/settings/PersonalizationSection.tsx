import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { cn } from '@renderer/lib/cn'
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

  const commitName = (): void => {
    if (name !== p.name) void update({ personalization: { name } })
  }
  const commitRole = (): void => {
    if (role !== p.role) void update({ personalization: { role } })
  }
  const commitAbout = (): void => {
    if (about !== p.about) void update({ personalization: { about } })
  }
  const setPronoun = (pronoun: Pronoun): void => {
    void update({ personalization: { pronoun } })
  }

  return (
    <>
      <Card className="mb-5">
        <p className="mb-4 text-[12px] text-muted">
          Tell the AI who you are, so summaries and coaching read like they understand your role —
          not generic sales advice.
        </p>
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-muted">Your name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              disabled={loading}
              maxLength={MAX_NAME}
              placeholder="e.g. Alex Rivera"
              className="w-full rounded-lg border border-line-soft bg-canvas px-3 py-2 text-sm outline-none transition focus:border-line"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-muted">Your role</label>
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              onBlur={commitRole}
              disabled={loading}
              maxLength={MAX_ROLE}
              placeholder="e.g. Account Executive at Acme Co"
              className="w-full rounded-lg border border-line-soft bg-canvas px-3 py-2 text-sm outline-none transition focus:border-line"
            />
          </div>
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-muted">
              Preferred pronoun for summaries
            </p>
            <div className="inline-flex rounded-lg border border-line p-0.5">
              {PRONOUNS.map((opt) => (
                <button
                  key={opt.id || 'skip'}
                  type="button"
                  disabled={loading}
                  onClick={() => setPronoun(opt.id)}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-[13px] font-medium transition disabled:cursor-default',
                    p.pronoun === opt.id ? 'bg-accent-soft text-ink' : 'text-muted hover:text-ink'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-muted">
              About your sales role / what you sell / your style
            </label>
            <textarea
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              onBlur={commitAbout}
              disabled={loading}
              maxLength={MAX_ABOUT}
              rows={4}
              placeholder="e.g. I sell mid-market SaaS deals, usually 3-6 month cycles, and I lead with ROI over feature lists."
              className="w-full resize-y rounded-lg border border-line-soft bg-canvas px-3 py-2 text-sm outline-none transition focus:border-line"
            />
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
