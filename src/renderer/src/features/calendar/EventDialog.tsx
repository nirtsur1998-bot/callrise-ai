import { useMemo, useState, type ReactNode } from 'react'
import { X, Trash2, Sparkles, PhoneCall } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { IconButton } from '@renderer/components/IconButton'
import { Button } from '@renderer/components/Button'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { fieldClass as sharedFieldClass } from '@renderer/components/field'
import { ContactPicker } from '@renderer/features/contacts/ContactPicker'
import { useContacts } from '@renderer/features/contacts/useContacts'
import { useDeals } from '@renderer/features/deals/useDeals'
import { useDealStages } from '@renderer/features/deals/useDealStages'
import type { EventDraft } from './types'

// Native date/time pickers need an explicit dark color-scheme, on top of the
// shared field styling.
const fieldClass = `${sharedFieldClass} [color-scheme:dark]`

function Field({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-faint">
        {label}
      </span>
      {children}
    </label>
  )
}

const REMINDER_OPTIONS = [5, 10, 15, 20, 30, 45, 60]

interface EventDialogProps {
  initial: EventDraft
  isEdit: boolean
  onClose: () => void
  onSubmit: (draft: EventDraft) => Promise<void>
  onDelete?: () => Promise<void>
  /** M19 Task 3B — present only when editing an existing event (a new,
   *  unsaved event has no identity to key a brief on). */
  onOpenPrepBrief?: () => void
  /** M31 Slice B — present only when a call was actually recorded during
   *  this meeting (a hard link written at save time, never a guess). This
   *  is where the plan hands off to the outcome: the chip and this dialog
   *  are always the PLAN, and reaching the call is a separate, labelled
   *  click rather than a click that silently changes what you get. */
  onOpenCall?: () => void
  /** True when two-way sync is on for Google and/or Outlook — reminders only
   *  reach the user's phone/desktop once this event actually pushes to one
   *  of those, so the picker explains itself when neither is connected. */
  syncEnabled?: boolean
}

export function EventDialog({
  initial,
  isEdit,
  onClose,
  onSubmit,
  onDelete,
  onOpenPrepBrief,
  onOpenCall,
  syncEnabled = false
}: EventDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState<EventDraft>(initial)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { contacts, create: createContact } = useContacts()
  const { deals } = useDeals()
  const { stages } = useDealStages()

  const set = (patch: Partial<EventDraft>): void => setDraft((d) => ({ ...d, ...patch }))

  // Same-day events can still be backwards (e.g. Start 3:00 PM / End 9:00 AM)
  // even though start/end dates are already clamped so the end date never
  // precedes the start date. All-day events don't carry meaningful times, so
  // skip this check for those.
  const timeError = useMemo(() => {
    if (draft.allDay) return null
    if (draft.startDate !== draft.endDate) return null
    if (!draft.startTime || !draft.endTime) return null
    return draft.endTime <= draft.startTime ? 'End time must be after start time.' : null
  }, [draft.allDay, draft.startDate, draft.endDate, draft.startTime, draft.endTime])

  const canSave = draft.title.trim().length > 0 && !busy && !timeError

  // Only the linked contact's OPEN deals make sense to tie a meeting to.
  const openStageIds = useMemo(
    () => new Set(stages.filter((s) => s.kind === 'open').map((s) => s.id)),
    [stages]
  )
  const contactDeals = useMemo(
    () =>
      draft.contactId
        ? deals.filter((d) => d.contactId === draft.contactId && openStageIds.has(d.stageId))
        : [],
    [deals, draft.contactId, openStageIds]
  )

  // The Modal's Escape handler always fires — guard the close itself instead,
  // so a save/delete in flight can't be abandoned mid-write.
  const guardedClose = (): void => {
    if (!busy) onClose()
  }

  const submit = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(draft)
    } catch (err) {
      console.error('Failed to save event:', err)
      setBusy(false)
      setError(
        `Could not save the event. ${err instanceof Error ? err.message : 'Please try again.'}`
      )
    }
  }

  const remove = async (): Promise<void> => {
    if (!onDelete) return
    setBusy(true)
    setError(null)
    try {
      await onDelete()
    } catch {
      setBusy(false)
      setError('Could not delete the event. Please try again.')
    }
  }

  return (
    <Modal
      onClose={guardedClose}
      title={isEdit ? 'Edit event' : 'New event'}
      initialFocus={false}
      className="flex max-h-[85vh] flex-col"
    >
      <div className="flex items-center justify-between gap-4 border-b border-line-soft px-6 py-4">
        <h2 className="text-sm font-semibold">{isEdit ? 'Edit event' : 'New event'}</h2>
        <IconButton icon={X} label="Close" onClick={guardedClose} disabled={busy} />
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-6 py-5">
        <Field label="Title">
          <input
            type="text"
            value={draft.title}
            autoFocus
            onChange={(e) => set({ title: e.target.value })}
            placeholder="What's happening?"
            className={fieldClass}
          />
        </Field>
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <ToggleSwitch
            checked={draft.allDay}
            onChange={(v) => set({ allDay: v })}
            label="All day event"
          />
          All day
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start date">
            <input
              type="date"
              value={draft.startDate}
              onChange={(e) => {
                const startDate = e.target.value
                // Keep the end on/after the start (compare YYYY-MM-DD strings).
                set({ startDate, endDate: draft.endDate < startDate ? startDate : draft.endDate })
              }}
              className={fieldClass}
            />
          </Field>
          <Field label="End date">
            <input
              type="date"
              value={draft.endDate}
              onChange={(e) => {
                const endDate = e.target.value
                set({ endDate: endDate < draft.startDate ? draft.startDate : endDate })
              }}
              className={fieldClass}
            />
          </Field>
        </div>
        {!draft.allDay && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start time">
              <input
                type="time"
                value={draft.startTime}
                onChange={(e) => set({ startTime: e.target.value })}
                className={fieldClass}
              />
            </Field>
            <Field label="End time">
              <input
                type="time"
                value={draft.endTime}
                onChange={(e) => set({ endTime: e.target.value })}
                className={fieldClass}
              />
            </Field>
          </div>
        )}
        {!draft.allDay && timeError && <p className="text-[12px] text-danger">{timeError}</p>}
        <Field label="Notes (optional)">
          <textarea
            value={draft.notes}
            onChange={(e) => set({ notes: e.target.value })}
            placeholder="Anything to remember"
            rows={3}
            className={`${fieldClass} resize-none`}
          />
        </Field>
        <Field label="Linked contact (optional)">
          <ContactPicker
            value={draft.contactId}
            contacts={contacts}
            onSelect={(contactId) => set({ contactId, dealId: undefined })}
            onCreate={createContact}
          />
        </Field>
        {draft.contactId && contactDeals.length > 0 && (
          <Field label="Linked deal (optional)">
            <select
              value={draft.dealId ?? ''}
              onChange={(e) => set({ dealId: e.target.value || undefined })}
              className={fieldClass}
            >
              <option value="">No deal</option>
              {contactDeals.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Reminders">
          <div className="flex flex-wrap gap-1.5">
            {REMINDER_OPTIONS.map((m) => {
              const active = draft.reminderMinutes.includes(m)
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() =>
                    set({
                      reminderMinutes: active
                        ? draft.reminderMinutes.filter((x) => x !== m)
                        : [...draft.reminderMinutes, m].sort((a, b) => a - b)
                    })
                  }
                  className={`rounded-md border px-2.5 py-1 text-[12px] font-medium transition ${
                    active
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-line-soft bg-canvas text-muted hover:text-ink'
                  }`}
                >
                  {m < 60 ? `${m}m` : '1h'}
                </button>
              )
            })}
          </div>
          {/* One short line, always. This sentence is the app's promise about
              whether a reminder will actually reach you, and it was long
              enough to be the text that got clipped at the bottom of the
              scroll area — a promise you could only read half of.
              The Outlook multi-reminder caveat is the part that made it
              long, so it now appears ONLY when it can apply (two or more
              lead times picked), which is rare. It also replaces the old
              "the soonest picked is used", which read as though picking 5m
              and 30m would remind you at 5m: outlook-sync.ts takes
              Math.max, so it fires 30 minutes before. Same behaviour,
              honest description. */}
          {/* "Sent to" rather than "fires" / "reaches your phone", on
              purpose. CallRise writes reminders to the provider and never
              reads them back (see BUG-136) — nothing here can confirm one
              landed, or notice if it was rejected. Claiming it WILL reach
              your phone states an outcome we cannot observe; describing
              what we actually do is the honest version, and the one that
              won't be quietly wrong the day a push starts failing. */}
          <p className="mt-1.5 text-[11px] text-faint">
            {syncEnabled
              ? 'Sent to Google/Outlook, which then reminds you — check there if it matters.'
              : 'Notifies you on this computer, only while CallRise AI is open.'}
          </p>
          {syncEnabled && draft.reminderMinutes.length > 1 && (
            <p className="mt-1 text-[11px] text-faint">
              Outlook allows one only — it uses {Math.max(...draft.reminderMinutes)}m, the earliest.
            </p>
          )}
          {!syncEnabled && (
            <p className="mt-1 text-[11px] text-faint">
              Turn on two-way sync in Settings → Calendar to get phone reminders.
            </p>
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          {isEdit && onOpenPrepBrief && (
            <Button variant="secondary" size="sm" icon={Sparkles} onClick={onOpenPrepBrief}>
              Prep brief
            </Button>
          )}
          {/* The one place the plan hands off to the outcome, said in words
              rather than implied by an icon. Only rendered when a real call
              was recorded during this meeting. */}
          {isEdit && onOpenCall && (
            <Button variant="secondary" size="sm" icon={PhoneCall} onClick={onOpenCall}>
              View the call
            </Button>
          )}
        </div>
        {error && <p className="text-[13px] text-danger">{error}</p>}
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-line-soft px-6 py-4">
        {isEdit && onDelete ? (
          confirmDelete ? (
            <div className="flex items-center gap-1.5">
              <Button variant="danger" size="sm" onClick={remove} disabled={busy}>
                Delete
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <IconButton
              icon={Trash2}
              label="Delete event"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              variant="danger"
            />
          )
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={guardedClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add event'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
