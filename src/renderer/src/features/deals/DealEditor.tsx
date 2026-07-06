import type { ReactNode } from 'react'
import { ContactPicker } from '@renderer/features/contacts/ContactPicker'
import { useContacts } from '@renderer/features/contacts/useContacts'
import type { DealDraft } from './draft'
import type { DealStage } from './types'

const fieldClass =
  'w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink placeholder:text-faint transition focus:border-accent focus:outline-none [color-scheme:dark]'

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

interface DealEditorProps {
  value: DealDraft
  onChange: (next: DealDraft) => void
  stages: DealStage[]
  autoFocus?: boolean
}

/** A compact form for one deal's fields. Fully controlled by the parent. */
export function DealEditor({
  value,
  onChange,
  stages,
  autoFocus
}: DealEditorProps): React.JSX.Element {
  const { contacts, create: createContact } = useContacts()
  const set = (patch: Partial<DealDraft>): void => onChange({ ...value, ...patch })

  return (
    <div className="space-y-3">
      <Field label="Deal name">
        <input
          type="text"
          value={value.title}
          autoFocus={autoFocus}
          onChange={(e) => set({ title: e.target.value })}
          placeholder="e.g. Acme Corp — annual plan"
          className={fieldClass}
        />
      </Field>

      <Field label="Contact">
        <ContactPicker
          value={value.contactId}
          contacts={contacts}
          onSelect={(contactId) => set({ contactId })}
          onCreate={createContact}
          required
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Stage">
          <select
            value={value.stageId}
            onChange={(e) => set({ stageId: e.target.value })}
            className={fieldClass}
          >
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Estimated value (optional)">
          <input
            type="number"
            min="0"
            step="1"
            value={value.value}
            onChange={(e) => set({ value: e.target.value })}
            placeholder="0"
            className={fieldClass}
          />
        </Field>
      </div>

      <Field label="Expected close date (optional)">
        <input
          type="date"
          value={value.expectedCloseDate}
          onChange={(e) => set({ expectedCloseDate: e.target.value })}
          className={fieldClass}
        />
      </Field>

      <Field label="Notes (optional)">
        <textarea
          value={value.notes}
          onChange={(e) => set({ notes: e.target.value })}
          placeholder="Anything worth remembering about this deal"
          rows={4}
          className={fieldClass}
        />
      </Field>
    </div>
  )
}
