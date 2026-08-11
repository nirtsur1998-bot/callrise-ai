import { useEffect, useRef, useState } from 'react'
import { Sparkles, Check, X, Loader2, AlertCircle } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { Button } from '@renderer/components/Button'
import { SegmentedControl } from '@renderer/components/SegmentedControl'

type CrmNoteLength = 'short' | 'medium' | 'detailed'

interface KycFact {
  id: string
  field: string
  text: string
  confidence: 'high' | 'medium'
}

const LENGTH_OPTIONS: { id: CrmNoteLength; label: string }[] = [
  { id: 'short', label: 'Short' },
  { id: 'medium', label: 'Medium' },
  { id: 'detailed', label: 'Detailed' }
]

const LENGTH_LABEL: Record<CrmNoteLength, string> = { short: 'Short', medium: 'Medium', detailed: 'Detailed' }

const KYC_FIELD_LABEL: Record<string, string> = {
  company: 'Company',
  title: 'Job Title',
  industry: 'Industry',
  companySize: 'Company Size',
  decisionAuthority: 'Decision Authority',
  otherStakeholders: 'Other Stakeholders',
  dealValue: 'Deal Value',
  pipelineStage: 'Pipeline Stage',
  leadSource: 'Lead Source',
  budgetIndication: 'Budget Indication',
  timeline: 'Timeline',
  competitors: 'Competitors',
  knownObjections: 'Known Objections',
  currentTooling: 'Current Tooling',
  preferredLanguage: 'Preferred Language',
  communicationStyle: 'Communication Style',
  timezone: 'Timezone',
  personalNotes: 'Personal Notes',
  briefingNotes: 'Briefing Notes'
}

interface CrmNoteGeneratorCardProps {
  contactId: string
  /** Called after a note save or an accepted KYC update actually changes the
   *  contact on disk — the parent re-fetches so the Comments list and
   *  header fields elsewhere on the page reflect it without a manual
   *  reload (mirrors useContacts()'s own create/update/remove pattern). */
  onContactUpdated?: () => void
}

/** M23 Workstream C — standalone CRM Note Generator, on the Contact page
 *  (gated by Settings → CRM → "CRM Note Generator"). Drafts a note from the
 *  contact's most recent call at a chosen length, plus a best-effort KYC
 *  harvest the rep accepts or rejects one fact at a time — nothing is saved
 *  until explicitly confirmed. */
export function CrmNoteGeneratorCard({
  contactId,
  onContactUpdated
}: CrmNoteGeneratorCardProps): React.JSX.Element {
  const [length, setLength] = useState<CrmNoteLength>('medium')
  const [generating, setGenerating] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // The length `note` was actually drafted at — lets the UI flag when the
  // segmented control has since been changed and the shown note no longer
  // matches the selected length.
  const [noteLength, setNoteLength] = useState<CrmNoteLength | null>(null)
  const [facts, setFacts] = useState<KycFact[]>([])
  const [appliedFactIds, setAppliedFactIds] = useState<Set<string>>(new Set())
  const [skippedFactIds, setSkippedFactIds] = useState<Set<string>>(new Set())
  // Which single fact's accept request is currently in flight — gates BOTH
  // of that fact's own buttons, so a Skip click can't race an in-flight
  // Update for the same fact (the write would land after the rep believed
  // they'd dismissed it).
  const [applyingFactId, setApplyingFactId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savingNote, setSavingNote] = useState(false)
  const [noteSaved, setNoteSaved] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const generate = async (): Promise<void> => {
    const requestedLength = length
    setGenerating(true)
    setError(null)
    setNote(null)
    setNoteLength(null)
    setFacts([])
    setAppliedFactIds(new Set())
    setSkippedFactIds(new Set())
    setNoteSaved(false)
    try {
      const res = await window.api.crmNoteGenerator.generate(contactId, requestedLength)
      if (!mountedRef.current) return
      if (res.ok) {
        setNote(res.note ?? null)
        setNoteLength(requestedLength)
        setFacts(res.facts ?? [])
      } else {
        setError(res.message ?? 'Could not draft a note. Please try again.')
      }
    } catch {
      if (mountedRef.current) setError('Could not draft a note. Please try again.')
    } finally {
      if (mountedRef.current) setGenerating(false)
    }
  }

  const saveNote = async (): Promise<void> => {
    if (!note) return
    setSavingNote(true)
    setError(null)
    try {
      const res = await window.api.crmNoteGenerator.save(contactId, note)
      if (!mountedRef.current) return
      if (res.ok) {
        setNoteSaved(true)
        onContactUpdated?.()
      } else {
        setError('Could not save that note. Please try again.')
      }
    } catch {
      if (mountedRef.current) setError('Could not save that note. Please try again.')
    } finally {
      if (mountedRef.current) setSavingNote(false)
    }
  }

  const decideFact = async (fact: KycFact, accept: boolean): Promise<void> => {
    if (!accept) {
      setSkippedFactIds((prev) => new Set(prev).add(fact.id))
      return
    }
    setApplyingFactId(fact.id)
    setError(null)
    try {
      const res = await window.api.crmNoteGenerator.applyFact(contactId, fact.field, fact.text)
      if (!mountedRef.current) return
      if (!res.ok) {
        setError('Could not save that update. Please try again.')
        return
      }
      setAppliedFactIds((prev) => new Set(prev).add(fact.id))
      onContactUpdated?.()
    } catch {
      if (mountedRef.current) setError('Could not save that update. Please try again.')
    } finally {
      if (mountedRef.current) setApplyingFactId(null)
    }
  }

  const visibleFacts = facts.filter((f) => !skippedFactIds.has(f.id))
  const lengthChanged = note !== null && noteLength !== null && noteLength !== length

  return (
    <Card className="mb-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold">Generate CRM note</h3>
        </div>
        <SegmentedControl options={LENGTH_OPTIONS} value={length} onChange={setLength} disabled={generating} />
      </div>

      <Button
        size="sm"
        icon={generating ? Loader2 : Sparkles}
        onClick={() => void generate()}
        disabled={generating || savingNote}
        className={generating ? '[&_svg]:animate-spin' : ''}
      >
        {generating ? 'Drafting…' : note ? 'Regenerate' : 'Generate from most recent call'}
      </Button>

      {error && <p className="mt-2.5 text-[12px] text-danger">{error}</p>}

      {note && (
        <div className="mt-3 rounded-xl border border-accent/30 bg-accent-soft p-3.5">
          {lengthChanged && (
            <p className="mb-2 flex items-center gap-1.5 text-[11px] text-warning">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              This note was drafted at {noteLength ? LENGTH_LABEL[noteLength] : ''} length — click Regenerate
              to redraft it at {LENGTH_LABEL[length]}.
            </p>
          )}
          <p className="whitespace-pre-wrap text-[13px] text-ink">{note}</p>
          {noteSaved ? (
            <p className="mt-2.5 flex items-center justify-end gap-1 text-[12px] font-medium text-positive">
              <Check className="h-3.5 w-3.5" /> Saved to contact
            </p>
          ) : (
            <div className="mt-2.5 flex justify-end gap-1.5">
              <Button size="sm" variant="secondary" icon={X} onClick={() => setNote(null)} disabled={savingNote}>
                Discard
              </Button>
              <Button
                size="sm"
                icon={savingNote ? Loader2 : Check}
                onClick={() => void saveNote()}
                disabled={savingNote}
                className={savingNote ? '[&_svg]:animate-spin' : ''}
              >
                Save to contact
              </Button>
            </div>
          )}
        </div>
      )}

      {visibleFacts.length > 0 && (
        <div className="mt-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-faint">Suggested updates</p>
          <div className="flex flex-col gap-2">
            {visibleFacts.map((fact) => {
              const applied = appliedFactIds.has(fact.id)
              const applying = applyingFactId === fact.id
              return (
                <div
                  key={fact.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-line-soft bg-canvas px-3.5 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-[11px] font-medium text-faint">
                      {KYC_FIELD_LABEL[fact.field] ?? fact.field}
                      {fact.confidence === 'medium' && (
                        <span className="rounded-full bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning">
                          Less certain
                        </span>
                      )}
                    </p>
                    <p className="text-[13px] text-ink">{fact.text}</p>
                  </div>
                  {applied ? (
                    <span className="flex shrink-0 items-center gap-1 text-[12px] font-medium text-positive">
                      <Check className="h-3.5 w-3.5" /> Updated
                    </span>
                  ) : (
                    <div className="flex shrink-0 gap-1.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={X}
                        onClick={() => void decideFact(fact, false)}
                        disabled={applying}
                      >
                        Skip
                      </Button>
                      <Button
                        size="sm"
                        icon={applying ? Loader2 : Check}
                        onClick={() => void decideFact(fact, true)}
                        disabled={applying}
                        className={applying ? '[&_svg]:animate-spin' : ''}
                      >
                        Update
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </Card>
  )
}
