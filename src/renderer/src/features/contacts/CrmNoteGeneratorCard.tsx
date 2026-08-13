import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkles, Check, X, Loader2, AlertCircle, ChevronDown } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { Button } from '@renderer/components/Button'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { useJobByTarget } from '@renderer/features/jobs/useJobByTarget'
import type { CrmNoteJobResult, KycFact } from '../../../../preload/index.d'

type CrmNoteLength = 'short' | 'medium' | 'detailed'

// M26 Phase 3 — this card used to hold the drafted note and every harvested
// suggestion in its own React state, so navigating off the Contact page
// permanently discarded whatever hadn't been dealt with yet, already paid
// for on the rep's own API key. Now the JOB owns both, plus the rep's
// decisions about them, so a reopen (even after an app restart) resumes
// exactly where they left off without re-running either AI call.
const GENERATE_JOB_TYPE = 'crmNote:generate'

const LENGTH_OPTIONS: { id: CrmNoteLength; label: string }[] = [
  { id: 'short', label: 'Short' },
  { id: 'medium', label: 'Medium' },
  { id: 'detailed', label: 'Detailed' }
]

const LENGTH_LABEL: Record<CrmNoteLength, string> = {
  short: 'Short',
  medium: 'Medium',
  detailed: 'Detailed'
}

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

function resultOf(resultData: unknown): CrmNoteJobResult | null {
  if (!resultData || typeof resultData !== 'object') return null
  const v = resultData as Record<string, unknown>
  if (typeof v.note !== 'string' || !Array.isArray(v.facts)) return null
  return v as unknown as CrmNoteJobResult
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
  // The length the CURRENT draft was generated at — read off the job's own
  // input so it survives a reopen, rather than a separate piece of state
  // that would reset to null and hide the "length changed" hint.
  const [error, setError] = useState<string | null>(null)
  const [applyingFactId, setApplyingFactId] = useState<string | null>(null)
  const [savingNote, setSavingNote] = useState(false)
  const [showSkipped, setShowSkipped] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Adopts an already-SUCCEEDED job too, not just running/queued — that IS
  // the fix: a draft the rep hasn't finished reviewing must be recoverable
  // by coming back to this contact, not only by watching it generate live.
  const [job, startJob] = useJobByTarget(GENERATE_JOB_TYPE, contactId, {
    adoptStates: ['running', 'queued', 'succeeded'],
    onFailed: (failed) =>
      setError(failed.error?.message ?? 'Could not draft a note. Please try again.')
  })

  const generating = job?.state === 'running' || job?.state === 'queued'
  const result = job?.state === 'succeeded' ? resultOf(job.resultData) : null
  const generatedLength = (job?.input as GenerateInput | undefined)?.length
  const noteHandled = !!result?.review?.noteHandled
  const note = result && !noteHandled ? result.note : null

  const acceptedIds = new Set(result?.review?.accepted ?? [])
  const skippedIds = new Set(result?.review?.skipped ?? [])
  const pendingFacts = (result?.facts ?? []).filter(
    (f) => !acceptedIds.has(f.id) && !skippedIds.has(f.id)
  )
  const skippedFacts = (result?.facts ?? []).filter((f) => skippedIds.has(f.id))

  const generate = useCallback(
    async (opts?: { force?: boolean }): Promise<void> => {
      setError(null)
      try {
        const res = await window.api.crmNoteGenerator.generate(contactId, length, opts)
        if (!mountedRef.current) return
        if (res.ok && res.jobId) {
          const fresh = await window.api.jobs.get(res.jobId)
          if (mountedRef.current && fresh) startJob(fresh)
        } else {
          setError(res.message ?? 'Could not draft a note. Please try again.')
        }
      } catch {
        if (mountedRef.current) setError('Could not draft a note. Please try again.')
      }
    },
    [contactId, length, startJob]
  )

  const saveNote = async (): Promise<void> => {
    if (!note || !job) return
    setSavingNote(true)
    setError(null)
    try {
      const res = await window.api.crmNoteGenerator.save(contactId, note, job.id)
      if (!mountedRef.current) return
      if (res.ok) onContactUpdated?.()
      else setError('Could not save that note. Please try again.')
    } catch {
      if (mountedRef.current) setError('Could not save that note. Please try again.')
    } finally {
      if (mountedRef.current) setSavingNote(false)
    }
  }

  const discardNote = async (): Promise<void> => {
    if (!job) return
    await window.api.crmNoteGenerator.discardNote(job.id).catch(() => {})
  }

  const decideFact = async (fact: KycFact, accept: boolean): Promise<void> => {
    if (!job) return
    if (!accept) {
      // Permanent by design — see crm-note-review.ts. Still listed under
      // "skipped" below so a mis-click leaves a trace.
      await window.api.crmNoteGenerator.skipFact(job.id, fact.id).catch(() => {})
      return
    }
    setApplyingFactId(fact.id)
    setError(null)
    try {
      const res = await window.api.crmNoteGenerator.applyFact(
        contactId,
        fact.field,
        fact.text,
        job.id,
        fact.id
      )
      if (!mountedRef.current) return
      if (!res.ok) {
        setError('Could not save that update. Please try again.')
        return
      }
      onContactUpdated?.()
    } catch {
      if (mountedRef.current) setError('Could not save that update. Please try again.')
    } finally {
      if (mountedRef.current) setApplyingFactId(null)
    }
  }

  const lengthChanged = note !== null && generatedLength !== undefined && generatedLength !== length

  return (
    <Card className="mb-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold">Generate CRM note</h3>
        </div>
        <SegmentedControl
          options={LENGTH_OPTIONS}
          value={length}
          onChange={setLength}
          disabled={generating}
        />
      </div>

      <Button
        size="sm"
        icon={generating ? Loader2 : Sparkles}
        onClick={() => void generate(result ? { force: true } : undefined)}
        disabled={generating || savingNote}
        className={generating ? '[&_svg]:animate-spin' : ''}
      >
        {generating ? 'Drafting…' : result ? 'Regenerate' : 'Generate from most recent call'}
      </Button>

      {error && <p className="mt-2.5 text-[12px] text-danger">{error}</p>}

      {note && (
        <div className="mt-3 rounded-xl border border-accent/30 bg-accent-soft p-3.5">
          {lengthChanged && (
            <p className="mb-2 flex items-center gap-1.5 text-[11px] text-warning">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              This note was drafted at {generatedLength ? LENGTH_LABEL[generatedLength] : ''} length
              — click Regenerate to redraft it at {LENGTH_LABEL[length]}.
            </p>
          )}
          <p className="whitespace-pre-wrap text-[13px] text-ink">{note}</p>
          <div className="mt-2.5 flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              icon={X}
              onClick={() => void discardNote()}
              disabled={savingNote}
            >
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
        </div>
      )}

      {noteHandled && result && (
        <p className="mt-2.5 flex items-center gap-1 text-[12px] font-medium text-positive">
          <Check className="h-3.5 w-3.5" /> Note handled
        </p>
      )}

      {pendingFacts.length > 0 && (
        <div className="mt-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
            Suggested updates
          </p>
          <div className="flex flex-col gap-2">
            {pendingFacts.map((fact) => {
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
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Skipping is permanent (a suggestion the rep already judged must not
          come back and re-ask). That makes a mis-click destructive in a way
          the old all-or-nothing loss never was, so skipped suggestions stay
          visible — collapsed, out of the way, but never silently gone. */}
      {skippedFacts.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowSkipped((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-faint transition hover:text-muted"
            aria-expanded={showSkipped}
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${showSkipped ? '' : '-rotate-90'}`}
            />
            {skippedFacts.length} suggestion{skippedFacts.length === 1 ? '' : 's'} skipped
          </button>
          {showSkipped && (
            <div className="mt-2 flex flex-col gap-1.5">
              {skippedFacts.map((fact) => (
                <div
                  key={fact.id}
                  className="rounded-lg border border-line-soft bg-canvas px-3 py-2 opacity-70"
                >
                  <p className="text-[11px] font-medium text-faint">
                    {KYC_FIELD_LABEL[fact.field] ?? fact.field}
                  </p>
                  <p className="text-[12px] text-muted line-through">{fact.text}</p>
                </div>
              ))}
              <p className="text-[11px] text-faint">
                Skipped suggestions aren&apos;t applied and won&apos;t be suggested again.
                Regenerate to take a fresh look.
              </p>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

interface GenerateInput {
  contactId: string
  length: CrmNoteLength
}
